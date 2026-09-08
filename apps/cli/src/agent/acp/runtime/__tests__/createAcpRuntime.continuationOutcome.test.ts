import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AgentMessage } from '@/agent';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Repair coverage for QF-AC-001.
 *
 * The independent quality gate proved that a provider-autonomous continuation which only ran
 * out of its inactivity safety budget was still projected as a *successful* turn: the runtime
 * published `task_complete` and recorded the turn completed. An inactivity stop is a safety
 * cap, not provider completion, so Happier was telling users that autonomous work had
 * finished while the provider may still have been working.
 *
 * These regressions deliberately drive the *real* `AcpBackend` lifecycle — its real stall
 * timer, its real `endAutonomousContinuation` path and its real emitted event — into the real
 * runtime projection, rather than asserting against a synthetic handler event only.
 */

const SESSION_ID = 'sess_continuation_outcome';
const STALL_MS = 40;

type Harness = {
  backend: AcpBackend;
  runtime: ReturnType<typeof createAcpRuntime>;
  plainCalls: ACPMessageData[];
  lifecycleCalls: string[];
  messageBuffer: MessageBuffer;
};

/**
 * Wire a real `AcpBackend` into a real runtime.
 *
 * The backend is not started (that would spawn a provider process); instead its emitted agent
 * messages are forwarded into the runtime's backend seam. Everything that produces the
 * continuation lifecycle — the stall timer, the terminal `task_complete` correlation, the
 * cancellation and disposal paths, and the event payload — is the real production code.
 */
async function createRuntimeHarness(): Promise<Harness> {
  const backend = new AcpBackend({
    agentName: 'copilot',
    cwd: process.cwd(),
    command: 'noop',
    providerAutonomousContinuation: { stallMs: STALL_MS },
  } as never);
  (backend as unknown as { acpSessionId: string }).acpSessionId = SESSION_ID;

  const fake = createFakeAcpRuntimeBackend({ sessionId: SESSION_ID });
  backend.onMessage((msg: AgentMessage) => fake.emit(msg));

  const plainCalls: ACPMessageData[] = [];
  const lifecycleCalls: string[] = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessage: (_provider, body) => {
      plainCalls.push(body);
    },
    sessionTurnLifecycle: {
      beginTurn: async () => {
        lifecycleCalls.push('begin');
        return { turnId: 'turn-continuation-outcome' };
      },
      completeTurn: async () => {
        lifecycleCalls.push('complete');
      },
      cancelTurn: async () => {
        lifecycleCalls.push('cancel');
      },
      // Only the three lifecycle transitions asserted here are exercised.
    } as never,
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
  return { backend, runtime, plainCalls, lifecycleCalls, messageBuffer };
}

/** Put the real backend into the exact post-`end_turn` state that arms a continuation. */
function completePromptTurn(backend: AcpBackend): void {
  const internals = backend as unknown as Record<string, unknown>;
  internals.turnGeneration = 1;
  internals.dispatchedPromptTurnGeneration = 1;
  internals.waitingForResponse = true;
  (internals.finalizeTurnOutcome as (o: unknown) => void).call(backend, {
    kind: 'completed',
    stopReason: 'end_turn',
  });
}

/** Feed one real `session/update` batch through the real backend notification path. */
async function pushUpdate(backend: AcpBackend, update: Record<string, unknown>): Promise<void> {
  const internals = backend as unknown as Record<string, unknown>;
  await (internals.handleSessionUpdate as (n: unknown) => Promise<void>).call(backend, {
    sessionId: SESSION_ID,
    update,
  });
}

const prose = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'PROVIDER_IS_STILL_WORKING' },
  messageChunk: { textDelta: 'PROVIDER_IS_STILL_WORKING' },
};

const taskCompleteCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_repair_1',
  title: 'task_complete',
  kind: 'other',
  status: 'pending',
  rawInput: { summary: 'REPAIR_SUMMARY' },
};

const taskCompleteTerminal = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_repair_1',
  status: 'completed',
};

const slowToolCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_slow_tool',
  title: 'bash',
  kind: 'execute',
  status: 'in_progress',
  rawInput: { command: 'sleep 600' },
};

function taskCompleteMessages(plainCalls: ACPMessageData[]): ACPMessageData[] {
  return plainCalls.filter((body) => body.type === 'task_complete');
}

function incompleteMarkers(plainCalls: ACPMessageData[]): ACPMessageData[] {
  return plainCalls.filter((body) => body.type === 'turn_aborted' || body.type === 'turn_cancelled');
}

describe('provider-autonomous continuation end outcomes', () => {
  it('does not report success when the real backend stall budget ends the continuation', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);

    // Let the real inactivity timer fire.
    await vi.waitFor(
      () => {
        expect(incompleteMarkers(h.plainCalls).length).toBeGreaterThan(0);
      },
      { timeout: 4000, interval: 10 },
    );
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(
      taskCompleteMessages(h.plainCalls),
      'an inactivity safety timeout is not successful provider completion',
    ).toHaveLength(0);
    expect(
      h.lifecycleCalls,
      'inactivity must be represented as an explicit non-success outcome',
    ).not.toContain('complete');
    expect(h.lifecycleCalls).toContain('cancel');
    expect(
      incompleteMarkers(h.plainCalls).map((body) => body.type),
      'the transcript lifecycle must expose the incomplete autonomous run',
    ).toContain('turn_aborted');

    h.backend.dispose?.();
  });

  it('preserves text the provider already produced when a continuation stalls', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);

    await vi.waitFor(
      () => {
        expect(incompleteMarkers(h.plainCalls).length).toBeGreaterThan(0);
      },
      { timeout: 4000, interval: 10 },
    );
    await h.runtime.waitForAutonomousContinuationIdle();

    const rendered = JSON.stringify(h.messageBuffer.getMessages?.() ?? []);
    expect(
      rendered.includes('PROVIDER_IS_STILL_WORKING'),
      'a stalled continuation must not discard output the provider already produced',
    ).toBe(true);

    h.backend.dispose?.();
  });

  it('still reports success when the provider itself completes the continuation', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);
    await pushUpdate(h.backend, taskCompleteCall);
    await pushUpdate(h.backend, taskCompleteTerminal);
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(
      taskCompleteMessages(h.plainCalls),
      'a correlated provider task_complete is a real completion and must be reported exactly once',
    ).toHaveLength(1);
    expect(h.lifecycleCalls).toContain('complete');
    expect(incompleteMarkers(h.plainCalls)).toHaveLength(0);

    h.backend.dispose?.();
  });

  it('does not report success when a continuation is cancelled by the user', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);
    await h.backend.cancel(SESSION_ID as never);
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(taskCompleteMessages(h.plainCalls)).toHaveLength(0);
    expect(
      incompleteMarkers(h.plainCalls).map((body) => body.type),
      'a user cancellation must be projected as a cancelled turn',
    ).toContain('turn_cancelled');
    expect(h.lifecycleCalls).not.toContain('complete');

    h.backend.dispose?.();
  });

  it('does not report success when a continuation is interrupted by backend disposal', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);
    h.backend.dispose?.();
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(taskCompleteMessages(h.plainCalls)).toHaveLength(0);
    expect(incompleteMarkers(h.plainCalls).length).toBeGreaterThan(0);
    expect(h.lifecycleCalls).not.toContain('complete');
  });

  it('does not report success when a new client prompt interrupts a continuation', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);
    // The client prompt loop settles an open continuation before it resets turn state.
    await h.runtime.settleAutonomousContinuation();

    expect(
      taskCompleteMessages(h.plainCalls),
      'a continuation cut short by the next prompt has not completed',
    ).toHaveLength(0);
    expect(incompleteMarkers(h.plainCalls).map((body) => body.type)).toContain('turn_cancelled');

    h.backend.dispose?.();
  });

  it('does not treat a slow but still running tool call as a stall', async () => {
    const h = await createRuntimeHarness();
    completePromptTurn(h.backend);
    await pushUpdate(h.backend, prose);
    await pushUpdate(h.backend, slowToolCall);

    // Several stall budgets elapse while the tool call is unresolved.
    await new Promise((resolve) => setTimeout(resolve, STALL_MS * 5));

    expect(
      taskCompleteMessages(h.plainCalls),
      'a running tool call must never be reported as completion',
    ).toHaveLength(0);
    expect(
      incompleteMarkers(h.plainCalls),
      'a running tool call is provider work in progress, not an inactivity stall',
    ).toHaveLength(0);

    // The tool finishes and the provider completes: the run is reported successfully.
    await pushUpdate(h.backend, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_slow_tool',
      status: 'completed',
    });
    await pushUpdate(h.backend, taskCompleteCall);
    await pushUpdate(h.backend, taskCompleteTerminal);
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(taskCompleteMessages(h.plainCalls)).toHaveLength(1);

    h.backend.dispose?.();
  });

  it('eventually stops an unresolved tool call instead of staying busy forever', async () => {
    const backend = new AcpBackend({
      agentName: 'copilot',
      cwd: process.cwd(),
      command: 'noop',
      providerAutonomousContinuation: { stallMs: 5 },
    } as never);
    (backend as unknown as { acpSessionId: string }).acpSessionId = SESSION_ID;
    const events: AgentMessage[] = [];
    backend.onMessage((msg) => events.push(msg));

    completePromptTurn(backend);
    await pushUpdate(backend, prose);
    await pushUpdate(backend, slowToolCall);

    await vi.waitFor(
      () => {
        const ended = events.find(
          (m) => m.type === 'event'
            && m.name === 'autonomous_continuation'
            && (m.payload as Record<string, unknown>)?.phase === 'ended',
        );
        expect(ended).toBeTruthy();
        expect((ended as { payload: Record<string, unknown> }).payload.outcome).toBe('timed_out');
      },
      { timeout: 8000, interval: 20 },
    );

    backend.dispose?.();
  });
});
