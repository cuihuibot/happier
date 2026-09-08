import { describe, expect, it } from 'vitest';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AgentMessage } from '@/agent';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Repair coverage for QF-AC-002.
 *
 * The continuation budget bounds how much autonomous provider work Happier accepts. It must
 * not decide whether the user gets to see output the provider already produced. Before this
 * repair, exhausting the budget dropped every later prompt-turn update behind a debug log, so
 * a truncated autonomous run was indistinguishable from a coherent finished one.
 *
 * The contract is now: exactly one *terminal limit segment* carries the first excess output
 * into the transcript and closes immediately as incomplete, after which the turn is latched so
 * later chunks neither open segments nor flood errors.
 */

const SESSION_ID = 'sess_cap';

type Harness = {
  backend: AcpBackend;
  runtime: ReturnType<typeof createAcpRuntime>;
  durableCalls: Array<{ localId: string; body: ACPMessageData }>;
  plainCalls: ACPMessageData[];
  events: AgentMessage[];
};

async function createHarness(maxPerTurn: number): Promise<Harness> {
  const backend = new AcpBackend({
    agentName: 'copilot',
    cwd: process.cwd(),
    command: 'noop',
    providerAutonomousContinuation: { maxPerTurn, stallMs: 1_000 },
  } as never);
  (backend as unknown as { acpSessionId: string }).acpSessionId = SESSION_ID;

  const fake = createFakeAcpRuntimeBackend({ sessionId: SESSION_ID });
  const events: AgentMessage[] = [];
  backend.onMessage((message: AgentMessage) => {
    events.push(message);
    fake.emit(message);
  });

  const durableCalls: Array<{ localId: string; body: ACPMessageData }> = [];
  const plainCalls: ACPMessageData[] = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessageCommitted: async (_provider, body, options) => {
      durableCalls.push({ localId: options.localId, body });
    },
    sendAgentMessage: (_provider, body) => {
      plainCalls.push(body);
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
    ensureBackend: async () => fake,
  });
  await runtime.startOrLoad({});
  return { backend, runtime, durableCalls, plainCalls, events };
}

function completePromptTurn(backend: AcpBackend): void {
  const internals = backend as unknown as Record<string, unknown>;
  internals.turnGeneration = 1;
  internals.dispatchedPromptTurnGeneration = 1;
  internals.waitingForResponse = true;
  (internals.finalizeTurnOutcome as (outcome: unknown) => void).call(backend, {
    kind: 'completed',
    stopReason: 'end_turn',
  });
}

async function pushUpdate(
  backend: AcpBackend,
  update: Record<string, unknown>,
  sessionId: string = SESSION_ID,
): Promise<void> {
  const internals = backend as unknown as Record<string, unknown>;
  await (internals.handleSessionUpdate as (notification: unknown) => Promise<void>).call(backend, {
    sessionId,
    update,
  });
}

function text(marker: string) {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: marker },
    messageChunk: { textDelta: marker },
  };
}

/** Run one complete continuation segment that the provider itself finishes. */
async function runCompletedSegment(h: Harness, id: string, marker: string): Promise<void> {
  await pushUpdate(h.backend, text(marker));
  await pushUpdate(h.backend, {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'task_complete',
    kind: 'other',
    status: 'pending',
    rawInput: { summary: `${marker}_DONE` },
  });
  await pushUpdate(h.backend, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
  await h.runtime.waitForAutonomousContinuationIdle();
}

type ContinuationEvent = Extract<AgentMessage, { type: 'event' }>;

function continuationPayloads(events: AgentMessage[]): Array<Record<string, unknown>> {
  return events
    .filter((m): m is ContinuationEvent => m.type === 'event' && m.name === 'autonomous_continuation')
    .map((m) => (m.payload ?? {}) as Record<string, unknown>);
}

function startedEvents(events: AgentMessage[]): Array<Record<string, unknown>> {
  return continuationPayloads(events).filter((payload) => payload.phase === 'started');
}

function endedOutcomes(events: AgentMessage[]): string[] {
  return continuationPayloads(events)
    .filter((payload) => payload.phase === 'ended')
    .map((payload) => String(payload.outcome));
}

function persisted(h: Harness, marker: string): boolean {
  return h.durableCalls.some(
    ({ body }) => body.type === 'message' && body.message.includes(marker),
  );
}

function incompleteMarkers(bodies: ACPMessageData[]): string[] {
  return bodies
    .filter((body) => body.type === 'turn_aborted' || body.type === 'turn_cancelled')
    .map((body) => body.type);
}

describe('provider-autonomous continuation cap exhaustion', () => {
  it('carries the first excess output into the transcript with an explicit incomplete outcome', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_FIRST_VISIBLE');

    const durableBefore = h.durableCalls.length;
    const plainBefore = h.plainCalls.length;
    await pushUpdate(h.backend, text('CAP_EXHAUSTED_OUTPUT_MUST_NOT_DISAPPEAR'));
    await h.runtime.waitForAutonomousContinuationIdle();

    const laterDurable = h.durableCalls.slice(durableBefore);
    const laterPlain = h.plainCalls.slice(plainBefore);
    expect(
      laterDurable.some(
        ({ body }) => body.type === 'message'
          && body.message.includes('CAP_EXHAUSTED_OUTPUT_MUST_NOT_DISAPPEAR'),
      ),
      'output beyond the continuation budget must still reach the transcript',
    ).toBe(true);
    expect(
      incompleteMarkers(laterPlain),
      'the truncated run must be reported as incomplete, not silently dropped',
    ).toContain('turn_aborted');
    expect(
      laterPlain.filter((body) => body.type === 'task_complete'),
      'cap exhaustion is never a successful completion',
    ).toHaveLength(0);
    expect(endedOutcomes(h.events)).toContain('limit_exceeded');

    h.backend.dispose?.();
  });

  it('reports the limit exactly once and does not flood later chunks', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_FIRST_VISIBLE');
    await pushUpdate(h.backend, text('CAP_EXCESS_ONE'));
    await h.runtime.waitForAutonomousContinuationIdle();

    const plainBefore = h.plainCalls.length;
    const startedBefore = startedEvents(h.events).length;
    for (const marker of ['CAP_EXCESS_TWO', 'CAP_EXCESS_THREE', 'CAP_EXCESS_FOUR']) {
      await pushUpdate(h.backend, text(marker));
    }
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(
      startedEvents(h.events).length - startedBefore,
      'the limit segment is a one-shot bound, not a way to keep opening segments',
    ).toBe(0);
    expect(
      incompleteMarkers(h.plainCalls.slice(plainBefore)),
      'the truncation must not be re-reported for every later chunk',
    ).toHaveLength(0);
    expect(endedOutcomes(h.events).filter((o) => o === 'limit_exceeded')).toHaveLength(1);

    h.backend.dispose?.();
  });

  it('honours the exact cap boundary before opening the limit segment', async () => {
    const h = await createHarness(2);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_SEG_ONE');
    await runCompletedSegment(h, 'cap_2', 'CAP_SEG_TWO');

    expect(endedOutcomes(h.events)).toEqual(['completed', 'completed']);
    expect(persisted(h, 'CAP_SEG_ONE')).toBe(true);
    expect(persisted(h, 'CAP_SEG_TWO')).toBe(true);

    await pushUpdate(h.backend, text('CAP_SEG_THREE_EXCESS'));
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(endedOutcomes(h.events)).toEqual(['completed', 'completed', 'limit_exceeded']);
    expect(persisted(h, 'CAP_SEG_THREE_EXCESS')).toBe(true);

    h.backend.dispose?.();
  });

  it('never opens a limit segment for a different session', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_FIRST_VISIBLE');

    const startedBefore = startedEvents(h.events).length;
    await pushUpdate(h.backend, text('CAP_OTHER_SESSION'), 'sess_someone_else');
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(startedEvents(h.events).length).toBe(startedBefore);

    h.backend.dispose?.();
  });

  it('never opens a limit segment for usage-only traffic', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_FIRST_VISIBLE');

    const startedBefore = startedEvents(h.events).length;
    await pushUpdate(h.backend, { sessionUpdate: 'usage_update', used: 10, size: 100 });
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(startedEvents(h.events).length).toBe(startedBefore);

    h.backend.dispose?.();
  });

  it('does not open a limit segment after cancellation disarms the turn', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_FIRST_VISIBLE');
    await h.backend.cancel(SESSION_ID as never);

    const startedBefore = startedEvents(h.events).length;
    await pushUpdate(h.backend, text('CAP_AFTER_CANCEL'));
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(startedEvents(h.events).length).toBe(startedBefore);

    h.backend.dispose?.();
  });

  it('does not open a limit segment once a new client prompt owns the session', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_FIRST_VISIBLE');

    // The next client prompt takes ownership of the session.
    const internals = h.backend as unknown as Record<string, unknown>;
    internals.waitingForResponse = true;

    const startedBefore = startedEvents(h.events).length;
    await pushUpdate(h.backend, text('CAP_AFTER_NEW_PROMPT'));
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(startedEvents(h.events).length).toBe(startedBefore);

    h.backend.dispose?.();
  });

  it('gives a fresh budget and a fresh limit latch to the next client turn', async () => {
    const h = await createHarness(1);
    completePromptTurn(h.backend);
    await runCompletedSegment(h, 'cap_1', 'CAP_T1_SEG');
    await pushUpdate(h.backend, text('CAP_T1_EXCESS'));
    await h.runtime.waitForAutonomousContinuationIdle();
    expect(endedOutcomes(h.events).filter((o) => o === 'limit_exceeded')).toHaveLength(1);

    // A second client prompt completes and re-arms the machine from scratch.
    const internals = h.backend as unknown as Record<string, unknown>;
    internals.dispatchedPromptTurnGeneration = internals.turnGeneration;
    internals.waitingForResponse = true;
    (internals.finalizeTurnOutcome as (outcome: unknown) => void).call(h.backend, {
      kind: 'completed',
      stopReason: 'end_turn',
    });

    await runCompletedSegment(h, 'cap_2', 'CAP_T2_SEG');
    expect(persisted(h, 'CAP_T2_SEG')).toBe(true);
    expect(endedOutcomes(h.events).filter((o) => o === 'completed')).toHaveLength(2);

    h.backend.dispose?.();
  });
});
