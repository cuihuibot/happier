import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createVendorResumeIdMetadataPublisher } from './createVendorResumeIdMetadataPublisher';

describe('createVendorResumeIdMetadataPublisher', () => {
  it('derives the metadata field from the manifest, preserves metadata, and awaits the write', async () => {
    let metadata = createTestMetadata({ name: 'keep-me' });
    const write = createDeferred<void>();
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater) => {
        metadata = updater(metadata);
        await write.promise;
      },
    });

    let settled = false;
    const publishing = publisher.persistBound({
      generation: 3,
      operation: 'create',
      vendorSessionId: ' qwen-1 ',
    }).then(() => { settled = true; });

    await Promise.resolve();
    expect(metadata).toEqual(createTestMetadata({ name: 'keep-me', qwenSessionId: 'qwen-1' }));
    expect(settled).toBe(false);

    write.resolve(undefined);
    await publishing;
    expect(settled).toBe(true);
  });

  it('shares an in-flight write and deduplicates only after success', async () => {
    const write = createDeferred<void>();
    const updateMetadata = vi.fn(async (_updater: (metadata: Metadata) => Metadata) => {
      await write.promise;
    });
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'kimi',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    const event = { generation: 0, operation: 'resume' as const, vendorSessionId: 'kimi-1' };

    const first = publisher.persistBound(event);
    const second = publisher.persistBound(event);
    expect(updateMetadata).toHaveBeenCalledTimes(1);

    write.resolve(undefined);
    await Promise.all([first, second]);
    await publisher.persistBound(event);
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('propagates a write failure and permits an exact retry', async () => {
    const updateMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'kilo',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    const event = { generation: 1, operation: 'create' as const, vendorSessionId: 'kilo-1' };

    await expect(publisher.persistBound(event)).rejects.toThrow('write failed');
    await expect(publisher.persistBound(event)).resolves.toBeUndefined();
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('does not rewrite an exact resume identity that is already durable in metadata', async () => {
    const metadata = createTestMetadata({ qwenSessionId: 'resume-1' });
    const updateMetadata = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => metadata,
      updateMetadata,
    });

    await expect(publisher.persistBound({
      generation: 2,
      operation: 'resume',
      vendorSessionId: ' resume-1 ',
    })).resolves.toBeUndefined();
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('persists and retries a resumed identity when metadata is not already durable', async () => {
    const updateMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    const event = { generation: 2, operation: 'resume' as const, vendorSessionId: 'resume-1' };

    await expect(publisher.persistBound(event)).rejects.toThrow('write failed');
    await expect(publisher.persistBound(event)).resolves.toBeUndefined();
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('still requires an acknowledged write for created identities even when the local snapshot matches', async () => {
    const updateMetadata = vi.fn().mockRejectedValue(new Error('write failed'));
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => createTestMetadata({ qwenSessionId: 'created-1' }),
      updateMetadata,
    });

    await expect(publisher.persistBound({
      generation: 2,
      operation: 'create',
      vendorSessionId: 'created-1',
    })).rejects.toThrow('write failed');
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('writes again for a new generation even when the opaque id is unchanged', async () => {
    const updateMetadata = vi.fn(async () => {});
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'kiro',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });

    await publisher.persistBound({ generation: 4, operation: 'create', vendorSessionId: 'same-id' });
    await publisher.persistBound({ generation: 5, operation: 'resume', vendorSessionId: 'same-id' });

    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty bound identity and an agent without a vendor resume field', async () => {    const updateMetadata = vi.fn(async () => {});
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    await expect(publisher.persistBound({
      generation: 0,
      operation: 'create',
      vendorSessionId: '   ',
    })).rejects.toThrow(/bound vendor session identity/i);
    expect(updateMetadata).not.toHaveBeenCalled();

    expect(() => createVendorResumeIdMetadataPublisher({
      agentId: 'customAcp',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    })).toThrow(/does not declare a vendor resume metadata field/i);
  });

  describe('deferred durability (after-first-persisted-turn agents)', () => {
    it('does not publish a created Copilot identity before the vendor session is durable', async () => {
      const updateMetadata = vi.fn(async () => {});
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => createTestMetadata(),
        updateMetadata,
      });

      await publisher.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'copilot-new' });

      expect(updateMetadata).not.toHaveBeenCalled();
    });

    it('publishes the created Copilot identity once the vendor session is confirmed durable', async () => {
      let metadata = createTestMetadata({ name: 'keep-me' });
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => metadata,
        updateMetadata: (updater) => { metadata = updater(metadata); },
      });

      await publisher.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'copilot-new' });
      await publisher.confirmVendorSessionDurable({ generation: 0, vendorSessionId: 'copilot-new' });

      expect(metadata).toEqual(createTestMetadata({ name: 'keep-me', copilotSessionId: 'copilot-new' }));
    });

    it('keeps a previously durable resume id instead of clobbering it with a fresh unusable session', async () => {
      let metadata = createTestMetadata({ copilotSessionId: 'copilot-durable' });
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => metadata,
        updateMetadata: (updater) => { metadata = updater(metadata); },
      });

      // Resume failed, so the runtime fell back to a brand new vendor session that
      // Copilot cannot load yet. The good id must survive.
      await publisher.persistBound({ generation: 1, operation: 'create', vendorSessionId: 'copilot-fresh' });

      expect(metadata).toEqual(createTestMetadata({ copilotSessionId: 'copilot-durable' }));

      await publisher.confirmVendorSessionDurable({ generation: 1, vendorSessionId: 'copilot-fresh' });
      expect(metadata).toEqual(createTestMetadata({ copilotSessionId: 'copilot-fresh' }));
    });

    it('ignores a durability confirmation from a superseded runtime generation', async () => {
      const updateMetadata = vi.fn(async () => {});
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => createTestMetadata(),
        updateMetadata,
      });

      await publisher.persistBound({ generation: 2, operation: 'create', vendorSessionId: 'copilot-new' });
      await publisher.confirmVendorSessionDurable({ generation: 1, vendorSessionId: 'copilot-new' });
      await publisher.confirmVendorSessionDurable({ generation: 2, vendorSessionId: 'copilot-other' });

      expect(updateMetadata).not.toHaveBeenCalled();
    });

    it('retries a deferred publication on a later durability confirmation after a transient write failure', async () => {
      const updateMetadata = vi.fn()
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce(undefined);
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => createTestMetadata(),
        updateMetadata,
      });

      await publisher.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'copilot-new' });
      await expect(publisher.confirmVendorSessionDurable({
        generation: 0,
        vendorSessionId: 'copilot-new',
      })).rejects.toThrow('write failed');

      // The runtime treats a failed publication as non-fatal, so the deferred binding must
      // survive for the next turn boundary; otherwise the durable id is lost for the session.
      await expect(publisher.confirmVendorSessionDurable({
        generation: 0,
        vendorSessionId: 'copilot-new',
      })).resolves.toBeUndefined();
      expect(updateMetadata).toHaveBeenCalledTimes(2);
    });

    it('keeps a newer deferred generation publishable when an older confirmation completes late', async () => {
      let metadata = createTestMetadata();
      const write = createDeferred<void>();
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => {
          metadata = updater(metadata);
          await write.promise;
        },
      });

      await publisher.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'copilot-old' });
      const publishingOld = publisher.confirmVendorSessionDurable({ generation: 0, vendorSessionId: 'copilot-old' });
      await Promise.resolve();

      // A new runtime generation supersedes the deferred binding while the old write is still open.
      await publisher.persistBound({ generation: 1, operation: 'create', vendorSessionId: 'copilot-new' });
      write.resolve(undefined);
      await publishingOld;

      await publisher.confirmVendorSessionDurable({ generation: 1, vendorSessionId: 'copilot-new' });
      expect(metadata).toEqual(createTestMetadata({ copilotSessionId: 'copilot-new' }));
    });

    it('does not let a late deferred confirmation overwrite a newer resumed identity', async () => {
      let metadata = createTestMetadata();
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => { metadata = updater(metadata); },
      });

      await publisher.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'copilot-old' });
      await publisher.persistBound({
        generation: 1,
        operation: 'resume',
        vendorSessionId: 'copilot-new',
      });
      await publisher.confirmVendorSessionDurable({
        generation: 0,
        vendorSessionId: 'copilot-old',
      });

      expect(metadata).toEqual(createTestMetadata({ copilotSessionId: 'copilot-new' }));
    });

    it('publishes a resumed Copilot identity immediately because the vendor session is already durable', async () => {
      const updateMetadata = vi.fn(async () => {});
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'copilot',
        getMetadataSnapshot: () => createTestMetadata(),
        updateMetadata,
      });

      await publisher.persistBound({ generation: 0, operation: 'resume', vendorSessionId: 'copilot-old' });

      expect(updateMetadata).toHaveBeenCalledTimes(1);
    });

    it('publishes immediately for agents whose vendor id is durable at session open', async () => {
      const updateMetadata = vi.fn(async () => {});
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: 'qwen',
        getMetadataSnapshot: () => createTestMetadata(),
        updateMetadata,
      });

      await publisher.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'qwen-new' });

      expect(updateMetadata).toHaveBeenCalledTimes(1);
    });
  });
});
