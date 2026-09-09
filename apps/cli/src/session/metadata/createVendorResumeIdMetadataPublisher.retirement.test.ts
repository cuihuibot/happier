import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createVendorResumeIdMetadataPublisher } from './createVendorResumeIdMetadataPublisher';

/**
 * A cancelled provider session that Happier had to retire stays resumable unless its durable
 * projection is removed. A later cold start reads that projection back as `--resume <id>`, which
 * hands the cancelled goal to the provider again.
 */
describe('createVendorResumeIdMetadataPublisher retirement', () => {
  const makePublisher = (initial: Metadata) => {
    let metadata = initial;
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'copilot',
      getMetadataSnapshot: () => metadata,
      updateMetadata: (updater) => { metadata = updater(metadata); },
    });
    return { publisher, read: () => metadata };
  };

  it('removes the durable projection of the retired session so a cold start gets no resume id', async () => {
    const { publisher, read } = makePublisher(
      createTestMetadata({ name: 'keep-me', copilotSessionId: 'retired-1' }),
    );

    await publisher.invalidateBound(' retired-1 ');

    expect(read()).toEqual(createTestMetadata({ name: 'keep-me' }));
    expect('copilotSessionId' in (read() as Record<string, unknown>)).toBe(false);
  });

  it('leaves a different session id alone', async () => {
    const { publisher, read } = makePublisher(
      createTestMetadata({ copilotSessionId: 'healthy-2' }),
    );

    await publisher.invalidateBound('retired-1');

    expect(read()).toEqual(createTestMetadata({ copilotSessionId: 'healthy-2' }));
  });

  it('still publishes the fresh session opened after the retirement', async () => {
    const { publisher, read } = makePublisher(
      createTestMetadata({ copilotSessionId: 'retired-1' }),
    );

    await publisher.invalidateBound('retired-1');
    await publisher.persistBound({ generation: 2, operation: 'create', vendorSessionId: 'fresh-2' });
    await publisher.confirmVendorSessionDurable({ generation: 2, vendorSessionId: 'fresh-2' });

    expect(read()).toEqual(createTestMetadata({ copilotSessionId: 'fresh-2' }));
  });

  it('drops a deferred binding for the retired id so it cannot be published later', async () => {
    const { publisher, read } = makePublisher(createTestMetadata({}));

    await publisher.persistBound({ generation: 1, operation: 'create', vendorSessionId: 'retired-1' });
    await publisher.invalidateBound('retired-1');
    await publisher.confirmVendorSessionDurable({ generation: 1, vendorSessionId: 'retired-1' });

    expect((read() as Record<string, unknown>).copilotSessionId).toBeUndefined();
  });

  it('waits for an in-flight publication so the clear cannot be overwritten by it', async () => {
    let metadata = createTestMetadata({});
    const write = createDeferred<void>();
    let first = true;
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'copilot',
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater) => {
        metadata = updater(metadata);
        if (first) { first = false; await write.promise; }
      },
    });

    const publishing = publisher.persistBound({ generation: 1, operation: 'resume', vendorSessionId: 'retired-1' });
    const invalidating = publisher.invalidateBound('retired-1');
    write.resolve(undefined);
    await Promise.all([publishing, invalidating]);

    expect((metadata as Record<string, unknown>).copilotSessionId).toBeUndefined();
  });

  it('does not write when nothing is persisted, and propagates a write failure', async () => {
    const updateMetadata = vi.fn((updater: (metadata: Metadata) => Metadata): void => { updater(createTestMetadata({})); });
    const empty = createVendorResumeIdMetadataPublisher({
      agentId: 'copilot',
      getMetadataSnapshot: () => createTestMetadata({}),
      updateMetadata,
    });
    await empty.invalidateBound('retired-1');
    expect(updateMetadata).not.toHaveBeenCalled();

    const failing = createVendorResumeIdMetadataPublisher({
      agentId: 'copilot',
      getMetadataSnapshot: () => createTestMetadata({ copilotSessionId: 'retired-1' }),
      updateMetadata: () => { throw new Error('metadata write refused'); },
    });
    await expect(failing.invalidateBound('retired-1')).rejects.toThrow('metadata write refused');
  });
});
