import { describe, expect, it, vi, afterEach } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

/**
 * Runtime projection coverage for provider-autonomous continuations.
 *
 * The backend re-opens a bounded continuation generation when the provider keeps
 * working after `session/prompt` resolved. The runtime must project that segment as
 * its own transcript turn so the continuation output is persisted exactly once.
 */

type DurableCall = { localId: string; body: ACPMessageData; meta?: Record<string, unknown> };

function createHarness() {
  const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
  const durableCalls: DurableCall[] = [];
  const plainCalls: Array<{ body: ACPMessageData }> = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessageCommitted: async (_provider, body, opts) => {
      durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
    },
    sendAgentMessage: (_provider, body) => {
      plainCalls.push({ body });
    },
  });
  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: '/tmp',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => backend,
  });
  return { backend, runtime, durableCalls, plainCalls };
}

function beginContinuation(backend: ReturnType<typeof createFakeAcpRuntimeBackend>) {
  backend.emit({
    type: 'event',
    name: 'autonomous_continuation',
    payload: { phase: 'started', continuationId: 'cont-1' },
  } satisfies AgentMessage);
}

function endContinuation(backend: ReturnType<typeof createFakeAcpRuntimeBackend>) {
  backend.emit({
    type: 'event',
    name: 'autonomous_continuation',
    payload: { phase: 'ended', continuationId: 'cont-1', reason: 'task_complete' },
  } satisfies AgentMessage);
}

/**
 * Distinct persisted transcript rows.
 *
 * The streamed transcript writer commits a row more than once (streaming checkpoint then
 * final commit) reusing one `localId`, so row identity — not call count — is what proves a
 * message was persisted exactly once.
 */
const persistedRowMessages = (calls: DurableCall[]): string[] => {
  const byLocalId = new Map<string, string>();
  for (const call of calls) {
    if (call.body.type !== 'message') continue;
    byLocalId.set(call.localId, (call.body as any).message as string);
  }
  return [...byLocalId.values()];
};

const messageBodies = (calls: Array<{ body: ACPMessageData }>) => calls
  .filter((call) => call.body.type === 'message')
  .map((call) => (call.body as any).message as string);

describe('createAcpRuntime provider-autonomous continuation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the stage-two task_complete summary after a stage-one commentary turn', async () => {
    const { backend, runtime, durableCalls } = createHarness();
    await runtime.startOrLoad({});

    // Stage one: an ordinary client-prompted turn that emits commentary and ends.
    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'QRP_366AC45A_STAGE_ONE' } satisfies AgentMessage);
    await runtime.flushTurn();

    // Stage two: the provider keeps working and reports completion autonomously.
    beginContinuation(backend);
    backend.emit({
      type: 'tool-call',
      toolName: 'task_complete',
      args: { summary: 'QRP_366AC45A_STAGE_TWO' },
      callId: 'call_ZXnnWnmnPCRqkxxnL6JI9Nqk',
    } satisfies AgentMessage);
    backend.emit({
      type: 'tool-result',
      toolName: 'task_complete',
      result: { ok: true },
      callId: 'call_ZXnnWnmnPCRqkxxnL6JI9Nqk',
    } satisfies AgentMessage);
    endContinuation(backend);
    await runtime.waitForAutonomousContinuationIdle();

    const messages = persistedRowMessages(durableCalls);
    expect(messages).toContain('QRP_366AC45A_STAGE_ONE');
    expect(messages.filter((m) => m === 'QRP_366AC45A_STAGE_TWO')).toHaveLength(1);
  });

  it('persists plain assistant prose emitted during an autonomous continuation', async () => {
    const { backend, runtime, durableCalls } = createHarness();
    await runtime.startOrLoad({});

    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'STAGE_ONE_PROSE' } satisfies AgentMessage);
    await runtime.flushTurn();

    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'AUTONOMOUS_PROSE_CONTINUATION' } satisfies AgentMessage);
    endContinuation(backend);
    await runtime.waitForAutonomousContinuationIdle();

    const messages = persistedRowMessages(durableCalls);
    expect(messages).toContain('STAGE_ONE_PROSE');
    expect(messages.filter((m) => m === 'AUTONOMOUS_PROSE_CONTINUATION')).toHaveLength(1);
  });

  it('does not duplicate a summary that the continuation already emitted as prose', async () => {
    const { backend, runtime, durableCalls } = createHarness();
    await runtime.startOrLoad({});

    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'STAGE_ONE' } satisfies AgentMessage);
    await runtime.flushTurn();

    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'CONTINUATION_PROSE' } satisfies AgentMessage);
    backend.emit({
      type: 'tool-call',
      toolName: 'task_complete',
      args: { summary: 'CONTINUATION_SUMMARY' },
      callId: 'call_dup',
    } satisfies AgentMessage);
    endContinuation(backend);
    await runtime.waitForAutonomousContinuationIdle();

    const messages = persistedRowMessages(durableCalls);
    expect(messages.filter((m) => m === 'CONTINUATION_PROSE')).toHaveLength(1);
    // The maintained fork rule: the task_complete summary is a fallback for a segment
    // that produced no ordinary assistant message, never an extra duplicate row.
    expect(messages).not.toContain('CONTINUATION_SUMMARY');
  });

  it('publishes a task lifecycle for the continuation instead of leaving it silent', async () => {
    const { backend, runtime, plainCalls } = createHarness();
    await runtime.startOrLoad({});

    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'STAGE_ONE' } satisfies AgentMessage);
    await runtime.flushTurn();
    const completionsAfterStageOne = plainCalls.filter((c) => (c.body as any).type === 'task_complete').length;

    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'STAGE_TWO' } satisfies AgentMessage);
    endContinuation(backend);
    await runtime.waitForAutonomousContinuationIdle();

    expect(
      plainCalls.filter((c) => (c.body as any).type === 'task_complete').length,
    ).toBe(completionsAfterStageOne + 1);
  });

  it('ignores a continuation that starts while a client turn is already in flight', async () => {
    const { backend, runtime, durableCalls } = createHarness();
    await runtime.startOrLoad({});

    runtime.beginTurn();
    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'IN_FLIGHT_TEXT' } satisfies AgentMessage);
    endContinuation(backend);
    await runtime.flushTurn();

    // The text belongs to the client-owned turn and must appear exactly once.
    expect(persistedRowMessages(durableCalls).filter((m) => m === 'IN_FLIGHT_TEXT')).toHaveLength(1);
  });

  it('does not discard continuation output when a new segment opens before the previous flush ran', async () => {
    // A provider segment boundary must never reset runtime turn state while the previous
    // segment's output is still unflushed.
    const { backend, runtime, durableCalls } = createHarness();
    await runtime.startOrLoad({});

    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'SEGMENT_ONE_PROSE' } satisfies AgentMessage);
    endContinuation(backend);
    // No await here: the next segment opens before the queued flush has run.
    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'SEGMENT_TWO_PROSE' } satisfies AgentMessage);
    endContinuation(backend);
    await runtime.waitForAutonomousContinuationIdle();

    const messages = persistedRowMessages(durableCalls);
    expect(messages.filter((m) => m.includes('SEGMENT_ONE_PROSE'))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('SEGMENT_TWO_PROSE'))).toHaveLength(1);
  });

  it('settles an open continuation before a new client turn resets runtime turn state', async () => {
    const { backend, runtime, durableCalls } = createHarness();
    await runtime.startOrLoad({});

    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'STAGE_ONE' } satisfies AgentMessage);
    await runtime.flushTurn();

    // The provider continues autonomously and is still mid-continuation when the user sends
    // the next prompt. The continuation output must not be discarded by the new turn.
    beginContinuation(backend);
    backend.emit({ type: 'model-output', textDelta: 'UNFLUSHED_CONTINUATION' } satisfies AgentMessage);

    await runtime.settleAutonomousContinuation();
    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'NEXT_CLIENT_TURN' } satisfies AgentMessage);
    await runtime.flushTurn();

    const messages = persistedRowMessages(durableCalls);
    expect(messages.filter((m) => m === 'UNFLUSHED_CONTINUATION')).toHaveLength(1);
    expect(messages.filter((m) => m === 'NEXT_CLIENT_TURN')).toHaveLength(1);
    // A late `ended` for the already-settled continuation must not flush the client turn again.
    endContinuation(backend);
    await runtime.waitForAutonomousContinuationIdle();
    expect(persistedRowMessages(durableCalls).filter((m) => m === 'NEXT_CLIENT_TURN')).toHaveLength(1);
  });
});
