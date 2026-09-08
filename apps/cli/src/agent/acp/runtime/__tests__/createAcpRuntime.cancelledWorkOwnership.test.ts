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
 * Repair coverage for QF-AC-004: cancelled autonomous work must never be republished as a
 * later generation's success.
 *
 * Observed live on native v6 (Happier session `cmtsuk7b70jsxnpp87u1zx8p3`): an active
 * continuation was aborted and closed `outcome=cancelled`, the user's next prompt completed,
 * and 13 s later the cancelled work's tool result, prose and `task_complete` opened a *new*
 * continuation after the completed generation and published success.
 *
 * The wire evidence explains why no correlation fix is possible. Against real Copilot
 * 1.0.84, `session/cancel` issued during autonomous work drew no response at all and the
 * provider kept running for a further 30 s, emitting a tool result, anonymous prose carrying
 * no identifier, and a **brand-new** `task_complete` tool call id. `session/update` params
 * are only `sessionId` and `update`, with no `_meta`. So a tool-id tombstone cannot cover
 * anonymous prose or new ids, and a quiet interval proves nothing. The connection is the only
 * sound attribution boundary, which is what these regressions pin.
 */

const SESSION_ID = 'sess_cancelled_ownership';

type Harness = {
  backend: AcpBackend;
  runtime: ReturnType<typeof createAcpRuntime>;
  plainCalls: ACPMessageData[];
  messageBuffer: MessageBuffer;
};

async function createRuntimeHarness(): Promise<Harness> {
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

  const fake = createFakeAcpRuntimeBackend({ sessionId: SESSION_ID });
  backend.onMessage((msg: AgentMessage) => fake.emit(msg));

  const plainCalls: ACPMessageData[] = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessage: (_provider, body) => {
      plainCalls.push(body);
    },
  });
  const messageBuffer = new MessageBuffer();
  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: '/tmp',
    session,
    messageBuffer,
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => fake,
  });
  await runtime.startOrLoad({});
  return { backend, runtime, plainCalls, messageBuffer };
}

/** Put the real backend into the exact post-`end_turn` state that arms a continuation. */
function completePromptTurn(backend: AcpBackend): void {
  const internals = backend as unknown as Record<string, unknown>;
  internals.turnGeneration = (internals.turnGeneration as number ?? 0) + 1;
  internals.dispatchedPromptTurnGeneration = internals.turnGeneration;
  internals.waitingForResponse = true;
  (internals.finalizeTurnOutcome as (o: unknown) => void).call(backend, {
    kind: 'completed',
    stopReason: 'end_turn',
  });
}

/** Feed one real `session/update` through the real backend notification path. */
async function pushUpdate(backend: AcpBackend, update: Record<string, unknown>): Promise<void> {
  const internals = backend as unknown as Record<string, unknown>;
  await (internals.handleSessionUpdate as (n: unknown) => Promise<void>).call(backend, {
    sessionId: SESSION_ID,
    update,
  });
}

/**
 * Deliver an update the way the retired connection's own handler would, i.e. bound to the
 * epoch that was current when that connection was created.
 */
async function pushUpdateFromEpoch(
  backend: AcpBackend,
  epoch: number,
  update: Record<string, unknown>,
): Promise<void> {
  const internals = backend as unknown as Record<string, unknown>;
  if ((internals.connectionEpoch as number) !== epoch) return; // retired epoch: handler drops it
  await pushUpdate(backend, update);
}

const slowToolCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_cancelled_slow',
  title: 'bash',
  kind: 'execute',
  status: 'in_progress',
  rawInput: { command: 'sleep 20' },
};

const lateToolResult = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_cancelled_slow',
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: 'CANCELLED_TOOL_OUTPUT' } }],
};

const anonymousLateProse = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'CANCELLED_LATE_PROSE' },
  messageChunk: { textDelta: 'CANCELLED_LATE_PROSE' },
};

/** A *new* tool call id, exactly as the real provider emitted after cancellation. */
const lateTaskCompleteCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_cancelled_new_summary',
  title: 'task_complete',
  kind: 'other',
  status: 'pending',
  rawInput: { summary: 'CANCELLED_FINAL_SUMMARY' },
};

const lateTaskCompleteTerminal = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_cancelled_new_summary',
  status: 'completed',
};

function taskCompleteMessages(plainCalls: ACPMessageData[]): ACPMessageData[] {
  return plainCalls.filter((body) => body.type === 'task_complete');
}

describe('cancelled autonomous work ownership', () => {
  it('never republishes cancelled output as the next completed generation', async () => {
    const h = await createRuntimeHarness();
    const internals = h.backend as unknown as Record<string, unknown>;

    // 1. Client turn completes and a provider-autonomous continuation opens with a slow tool.
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, slowToolCall);
    const cancelledEpoch = internals.connectionEpoch as number;
    expect(
      internals.autonomousContinuationGeneration,
      'the scenario requires an open autonomous continuation',
    ).not.toBeNull();

    // 2. The user aborts while that tool is still unresolved.
    await h.backend.cancel(SESSION_ID as never);
    const beforeLateOutput = taskCompleteMessages(h.plainCalls).length;

    // 3. The user's next prompt completes successfully in the same Happier session.
    completePromptTurn(h.backend);

    // 4. The cancelled work's output finally arrives: old tool result, anonymous prose, and a
    //    brand-new task_complete id — exactly the frames captured on the wire.
    await pushUpdateFromEpoch(h.backend, cancelledEpoch, lateToolResult);
    await pushUpdateFromEpoch(h.backend, cancelledEpoch, anonymousLateProse);
    await pushUpdateFromEpoch(h.backend, cancelledEpoch, lateTaskCompleteCall);
    await pushUpdateFromEpoch(h.backend, cancelledEpoch, lateTaskCompleteTerminal);
    await h.runtime.waitForAutonomousContinuationIdle?.();

    expect(
      taskCompleteMessages(h.plainCalls).length,
      'cancelled work must not publish a successful completion after the next turn',
    ).toBe(beforeLateOutput);

    const rendered = JSON.stringify(h.messageBuffer.getMessages?.() ?? []);
    expect(rendered.includes('CANCELLED_FINAL_SUMMARY')).toBe(false);
    expect(rendered.includes('CANCELLED_LATE_PROSE')).toBe(false);

    h.backend.dispose?.();
  });

  it('retires the provider connection because ACP cannot cancel autonomous work', async () => {
    const h = await createRuntimeHarness();
    const internals = h.backend as unknown as Record<string, unknown>;

    completePromptTurn(h.backend);
    await pushUpdate(h.backend, slowToolCall);
    const epochBefore = internals.connectionEpoch as number;

    await h.backend.cancel(SESSION_ID as never);

    expect(
      h.backend.isProviderConnectionForceClosed(),
      'the runtime must be told to reopen, so the session stays usable',
    ).toBe(true);
    expect(internals.connection, 'the uncancellable provider connection must be dropped').toBeNull();
    // The old handler epoch is now stale, so its in-flight callbacks are rejected.
    expect(internals.connectionEpoch).toBe(epochBefore);

    h.backend.dispose?.();
  });

  it('poisons the provider session so resuming cannot resurrect the cancelled job', async () => {
    const h = await createRuntimeHarness();

    completePromptTurn(h.backend);
    await pushUpdate(h.backend, slowToolCall);
    expect(h.backend.isProviderSessionResumePoisoned()).toBe(false);

    await h.backend.cancel(SESSION_ID as never);

    // Live on native v7: retirement stopped the old connection, but the recovery resumed the
    // same provider session id, the provider restored the cancelled instruction and re-ran the
    // entire plan under the next prompt's turn with brand-new tool call ids. Retiring the
    // transport is therefore necessary but not sufficient; the provider session must be
    // abandoned too.
    expect(
      h.backend.isProviderSessionResumePoisoned(),
      'a resumed provider session hands the cancelled work straight back',
    ).toBe(true);

    h.backend.dispose?.();
  });

  it('keeps cooperative prompt-turn cancellation on the connection', async () => {
    const h = await createRuntimeHarness();
    const internals = h.backend as unknown as Record<string, unknown>;

    // An in-flight prompt request is cancellable by protocol: attribution survives, so the
    // connection must be preserved and the round-4 cooperative behaviour kept.
    internals.turnGeneration = 1;
    internals.dispatchedPromptTurnGeneration = 1;
    internals.waitingForResponse = true;

    await h.backend.cancel(SESSION_ID as never);

    expect(
      h.backend.isProviderConnectionForceClosed(),
      'a cooperative cancellation must not retire a healthy provider connection',
    ).toBe(false);
    expect(internals.connection).not.toBeNull();
    expect(
      h.backend.isProviderSessionResumePoisoned(),
      'a cooperatively cancelled session keeps its provider context and stays resumable',
    ).toBe(false);

    h.backend.dispose?.();
  });

  it('retires the connection when a continuation is armed but has produced nothing yet', async () => {
    const h = await createRuntimeHarness();
    const internals = h.backend as unknown as Record<string, unknown>;

    // Armed-with-no-output-yet has the same exposure: the provider may already be working.
    completePromptTurn(h.backend);
    expect(internals.autonomousContinuationArmedGeneration).not.toBeNull();
    expect(internals.autonomousContinuationGeneration).toBeNull();

    await h.backend.cancel(SESSION_ID as never);

    expect(
      h.backend.isProviderConnectionForceClosed(),
      'armed autonomous work is still uncancellable provider work',
    ).toBe(true);

    h.backend.dispose?.();
  });

  it('does not retire connections for providers without the continuation capability', async () => {
    const backend = new AcpBackend({
      agentName: 'gemini',
      cwd: process.cwd(),
      command: 'noop',
    } as never);
    (backend as unknown as { acpSessionId: string }).acpSessionId = SESSION_ID;
    (backend as unknown as { connection: unknown }).connection = {
      peer: { cancel: async () => ({}), prompt: async () => ({ stopReason: 'end_turn' }) },
      close: () => {},
      closed: Promise.resolve(),
    };

    await backend.cancel(SESSION_ID as never);

    expect(
      backend.isProviderConnectionForceClosed(),
      'providers that never run autonomous continuations must be unaffected',
    ).toBe(false);
    expect((backend as unknown as { connection: unknown }).connection).not.toBeNull();

    backend.dispose?.();
  });
});
