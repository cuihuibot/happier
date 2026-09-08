import { describe, expect, it } from 'vitest';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AgentMessage } from '@/agent';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { Metadata } from '@/api/types';
import { createVendorResumeIdMetadataPublisher } from '@/session/metadata/createVendorResumeIdMetadataPublisher';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Round-6 boundary: a cancellation that retires the provider connection must also survive a
 * restart of the Happier session process.
 *
 * Observed live on native v9 (Quinann daemon log, 2026-09-09T00:24). Happier session
 * `cmtsxu3at0lulnpp8fncwziga` completed a turn, then an autopilot continuation was aborted and
 * the backend logged `retiring the provider connection`. The session process was stopped and
 * the next prompt respawned it with `hasResume:true` and
 * `--resume 288f708b-…`, i.e. the *retired* provider session. Round 5 separately proved on v7
 * that resuming such a session restores the cancelled goal and re-runs the whole plan.
 *
 * The round-5 in-memory poison flag cannot cover this: it dies with the process. Only removing
 * the durable projection does, which is what these regressions pin.
 */

const SESSION_ID = 'sess_retired_provider';

type Harness = {
  backend: AcpBackend;
  events: unknown[];
  statuses: { status: string; detail?: string }[];
  getMetadata: () => Metadata;
};

function createHarness(opts?: {
  initialMetadata?: Metadata;
  failMetadataWrite?: boolean;
}): Harness {
  const backend = new AcpBackend({
    agentName: 'copilot',
    cwd: process.cwd(),
    command: 'noop',
    providerAutonomousContinuation: { stallMs: 60_000 },
  } as never);
  (backend as unknown as { acpSessionId: string }).acpSessionId = SESSION_ID;
  (backend as unknown as { connection: unknown }).connection = {
    peer: { cancel: async () => ({}), prompt: async () => ({ stopReason: 'end_turn' }) },
    close: () => {},
    closed: Promise.resolve(),
  };

  let metadata = opts?.initialMetadata
    ?? createTestMetadata({ name: 'keep-me', copilotSessionId: SESSION_ID });
  const events: unknown[] = [];
  const statuses: { status: string; detail?: string }[] = [];
  backend.onMessage((msg: AgentMessage) => {
    if ((msg as { type?: string }).type === 'status') {
      statuses.push(msg as unknown as { status: string; detail?: string });
    }
  });

  const session = createBasicSessionClientWithOverrides({
    updateMetadata: (handler: (m: Metadata) => Metadata) => {
      if (opts?.failMetadataWrite) throw new Error('metadata write refused');
      metadata = handler(metadata) as Metadata;
    },
    getMetadataSnapshot: () => metadata,
    sendSessionEvent: (event: unknown) => { events.push(event); },
  } as never);

  const publisher = createVendorResumeIdMetadataPublisher({
    agentId: 'copilot',
    getMetadataSnapshot: () => metadata,
    updateMetadata: (updater) => session.updateMetadata(updater as never),
  });

  const fake = createFakeAcpRuntimeBackend({ sessionId: SESSION_ID });
  backend.onMessage((msg: AgentMessage) => fake.emit(msg));
  // The runtime registers the retirement handler on the backend it is handed, so the fake must
  // forward that registration to the real backend under test.
  type RetirementHandler = Parameters<AcpBackend['setProviderSessionRetirementHandler']>[0];
  (fake as unknown as Record<string, unknown>).setProviderSessionRetirementHandler = (
    handler: RetirementHandler,
  ): void => { backend.setProviderSessionRetirementHandler(handler); };

  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: '/tmp',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => fake,
    sessionIdentity: {
      kind: 'persist-bound',
      persistBound: publisher.persistBound,
      confirmVendorSessionDurable: publisher.confirmVendorSessionDurable,
      invalidateBound: publisher.invalidateBound,
    },
  } as never);
  void runtime.startOrLoad({});

  return { backend, events, statuses, getMetadata: () => metadata };
}

/** Put the backend into the state where cancellation must retire the connection. */
function armUncancellableAutonomousWork(backend: AcpBackend): void {
  const internals = backend as unknown as Record<string, unknown>;
  internals.sessionModeState = {
    currentModeId: 'https://agentclientprotocol.com/protocol/session-modes#autopilot',
  };
  internals.autonomousContinuationOpen = true;
  internals.waitingForResponse = true;
}

describe('retired provider session durability', () => {
  it('removes the durable resume projection before reporting the cancellation as stopped', async () => {
    const h = createHarness();
    await Promise.resolve();
    armUncancellableAutonomousWork(h.backend);

    await h.backend.cancel(SESSION_ID as never);

    expect((h.getMetadata() as Record<string, unknown>).copilotSessionId).toBeUndefined();
    // The rest of the session record is untouched: history and identity are not the hazard.
    expect((h.getMetadata() as Record<string, unknown>).name).toBe('keep-me');
    expect(h.statuses.at(-1)?.status).toBe('stopped');
  });

  it('records a durable transcript notice that the next turn uses a fresh agent context', async () => {
    const h = createHarness();
    await Promise.resolve();
    armUncancellableAutonomousWork(h.backend);

    await h.backend.cancel(SESSION_ID as never);

    const notice = h.events.find((e) => (e as { type?: string }).type === 'message') as
      { message?: string } | undefined;
    expect(notice?.message).toMatch(/fresh agent context/i);
    // The notice explains a lost context; it must never look like an answer to the user's task.
    expect(notice?.message).not.toMatch(new RegExp(SESSION_ID));
  });

  it('reports an error instead of a clean stop when the projection cannot be removed', async () => {
    const h = createHarness({ failMetadataWrite: true });
    await Promise.resolve();
    armUncancellableAutonomousWork(h.backend);

    await h.backend.cancel(SESSION_ID as never);

    const last = h.statuses.at(-1);
    expect(last?.status).toBe('error');
    expect(last?.detail).toMatch(/could not be permanently disconnected/i);
    expect(h.statuses.some((s) => s.status === 'stopped')).toBe(false);
  });

  it('leaves an ordinary-mode cancellation resumable, because its work really does stop', async () => {
    const h = createHarness();
    await Promise.resolve();
    const internals = h.backend as unknown as Record<string, unknown>;
    internals.sessionModeState = { currentModeId: 'default' };
    internals.waitingForResponse = true;

    await h.backend.cancel(SESSION_ID as never);

    expect((h.getMetadata() as Record<string, unknown>).copilotSessionId).toBe(SESSION_ID);
    expect(h.events.some((e) => (e as { type?: string }).type === 'message')).toBe(false);
  });

  it('does not re-fire retirement for a second cancel after the connection is gone', async () => {
    const h = createHarness();
    await Promise.resolve();
    armUncancellableAutonomousWork(h.backend);

    await h.backend.cancel(SESSION_ID as never);
    const noticesAfterFirst = h.events.length;
    await h.backend.cancel(SESSION_ID as never);

    expect(h.events.length).toBe(noticesAfterFirst);
  });
});
