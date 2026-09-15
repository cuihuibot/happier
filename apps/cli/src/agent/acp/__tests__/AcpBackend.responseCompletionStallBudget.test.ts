import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { BasePermissionHandler } from '@/agent/permissions/BasePermissionHandler';
import { PERMISSION_RESPONSE_CLAIM_V1 } from '@/agent/permissions/agentStateRequestStore';
import type { AgentMessage } from '@/agent/core/AgentMessage';

/**
 * Silent-stop safeguard for the generic ACP runtime.
 *
 * `createAcpRuntime.ts` calls `waitForResponseComplete()` with no argument, which
 * left the wait completely unbounded: a provider that emitted session/update
 * traffic and then went silent without ever answering `session/prompt` stranded the
 * turn with no terminal outcome and no runtime issue.
 *
 * The bound is a *stall* budget, not a whole-turn deadline: continued session/update
 * activity refreshes it, and a pending human permission decision suspends it.
 */

const SESSION_ID = 'sess_stall_budget';
const STALL_MS = 5_000;

function createBackend(options?: Record<string, unknown>) {
  const backend = new AcpBackend({
    agentName: 'copilot',
    cwd: process.cwd(),
    command: 'noop',
    ...options,
  } as never);
  const emitted: AgentMessage[] = [];
  backend.onMessage((msg) => emitted.push(msg));
  (backend as any).acpSessionId = SESSION_ID;
  // Exactly the state the runtime is in while it awaits the prompt response.
  (backend as any).turnGeneration = 1;
  (backend as any).dispatchedPromptTurnGeneration = 1;
  // The `session/prompt` RPC has not been answered yet: this is what makes a
  // silent stop possible, and it keeps idle status deferred as in the real turn.
  (backend as any).pendingPromptResponseTurnGeneration = 1;
  (backend as any).waitingForResponse = true;
  return { backend, emitted };
}

async function sendUpdate(backend: AcpBackend, text: string): Promise<void> {
  await (backend as any).handleSessionUpdate({
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      messageChunk: { textDelta: text },
    },
  });
}

/** Settle microtasks without letting the fake clock advance. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AcpBackend response-completion stall budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = String(STALL_MS);
  });

  afterEach(() => {
    delete process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails an updates-then-silence turn after the configured stall budget when the owner passes no timeout', async () => {
    const { backend } = createBackend();

    const wait = backend.waitForResponseComplete();
    const observed = wait.then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'thinking');
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    // Still inside the budget measured from the last update.
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');

    await vi.advanceTimersByTimeAsync(2);
    const result = await observed;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timeout waiting for response/i);
  });

  it('does not fail while session/update traffic keeps arriving past 60 and 90 seconds', async () => {
    const { backend } = createBackend();

    const wait = backend.waitForResponseComplete();
    const observed = wait.then(() => 'resolved' as const, (error: Error) => error);

    // 90 simulated seconds of steady progress, each gap well inside the budget.
    for (let elapsed = 0; elapsed < 90_000; elapsed += STALL_MS / 2) {
      await sendUpdate(backend, `chunk-${elapsed}`);
      await vi.advanceTimersByTimeAsync(STALL_MS / 2);
    }

    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
  });

  it('keeps an explicit null/0 opt-out unbounded', async () => {
    for (const optOut of [null, 0] as const) {
      const { backend } = createBackend();
      const observed = backend
        .waitForResponseComplete(optOut)
        .then(() => 'resolved' as const, (error: Error) => error);

      await sendUpdate(backend, 'one');
      await vi.advanceTimersByTimeAsync(STALL_MS * 20);

      expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');
      expect((backend as any).responseCompletionTimeout).toBeNull();
    }
  });

  it('does not expire the turn while a published, actionable human permission decision is pending', async () => {
    const actionable = new Set<string>(['perm-1']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-1');

    // A human takes far longer than the stall budget to answer.
    await vi.advanceTimersByTimeAsync(STALL_MS * 4);
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');

    // Resolving the decision re-arms the watchdog rather than leaving it suspended.
    (backend as any).endPendingPermissionDecision('perm-1');
    await flush();
    expect((backend as any).responseCompletionTimeout).not.toBeNull();

    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    const result = await observed;
    expect(result).toBeInstanceOf(Error);
  });

  it('fails deterministically when the pending permission request is never published or actionable', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        // Publication failed: no client can ever see or answer this prompt.
        isPendingRequestActionable: () => false,
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-unpublished');

    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    const result = await observed;
    expect(result).toBeInstanceOf(Error);
    // The same visible terminal path the runtime turns into `lastRuntimeIssue`.
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
    expect((backend as any).waitingForResponse).toBe(false);
  });

  it('suspends instead of failing when publication lands after the request was registered', async () => {
    const actionable = new Set<string>();
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-late');

    // The durable agent-state write completes slightly after the provider blocked.
    actionable.add('perm-late');

    await vi.advanceTimersByTimeAsync(STALL_MS * 4);
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
  });

  it('does not double-terminalize when the connection closes after an unactionable permission expired', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        isPendingRequestActionable: () => false,
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-unpublished');
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    await observed;

    const firstOutcome = (backend as any).lastTurnOutcome;
    expect(firstOutcome?.kind).toBe('failed');
    expect((backend as any).waitingForResponse).toBe(false);

    // A later connection close for the same turn must not replace the first outcome.
    (backend as any).handleProviderStreamTerminated('ACP connection closed');
    expect((backend as any).lastTurnOutcome).toBe(firstOutcome);
    expect((backend as any).responseCompletionError).toBeNull();
  });

  it('resumes the budget when a pending request stops being actionable, with no further provider update', async () => {
    const actionable = new Set<string>(['perm-claimed']);
    const { backend } = createBackend({
      permissionHandler: {
        // The provider stays blocked on this call for the whole test: nothing
        // resolves the decision, and no session/update ever arrives again.
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-claimed');

    await vi.advanceTimersByTimeAsync(STALL_MS * 2);
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');

    // A newer runtime claims the durable response, or the request disappears from
    // agent state. No client can answer it any more, so the person no longer owns
    // the silence and the suspension must lapse on its own.
    actionable.delete('perm-claimed');

    await vi.advanceTimersByTimeAsync(STALL_MS * 2 + 1);
    const result = await observed;
    expect(result).toBeInstanceOf(Error);
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
    expect((backend as any).waitingForResponse).toBe(false);
  });

  it('stays suspended while any one of several pending requests is still actionable', async () => {
    const actionable = new Set<string>(['perm-b']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-a');
    (backend as any).beginPendingPermissionDecision('perm-b');

    // `perm-a` was never publishable, but `perm-b` is a real human prompt.
    await vi.advanceTimersByTimeAsync(STALL_MS * 3);
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');

    // Once the last actionable prompt is gone, the budget resumes for both.
    actionable.delete('perm-b');
    await vi.advanceTimersByTimeAsync(STALL_MS * 2 + 1);
    expect(await observed).toBeInstanceOf(Error);
  });

  it('does not re-arm or re-terminalize when a permission resolves after the turn already failed', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: () => false,
      },
    });
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-late-answer');
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    await observed;

    const firstOutcome = (backend as any).lastTurnOutcome;
    expect(firstOutcome?.kind).toBe('failed');

    // A cancellation or late decision for the dead turn must not resurrect a timer.
    (backend as any).endPendingPermissionDecision('perm-late-answer');
    await flush();
    expect((backend as any).responseCompletionTimeout).toBeNull();
    expect((backend as any).lastTurnOutcome).toBe(firstOutcome);
    expect((backend as any).waitingForResponse).toBe(false);
  });

  it('reaches a terminal failed outcome and clears active turn state on expiry', async () => {
    const { backend } = createBackend();
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'then silence');
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    await observed;

    // The terminal outcome is what the runtime turns into `lastRuntimeIssue`
    // via surfacePromptFailure(); an unresolved wait publishes nothing.
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
    expect((backend as any).waitingForResponse).toBe(false);
    expect((backend as any).responseCompletionTimeout).toBeNull();
  });

  it('terminalizes a turn when the provider process exits cleanly mid-turn, without double-terminalizing', async () => {
    const { backend } = createBackend();
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'work started');

    // A clean `exit 0` before the prompt response is still a silent stop.
    (backend as any).handleProviderStreamTerminated('Exit code: 0');
    const first = await observed;
    expect(first).toBeInstanceOf(Error);
    const firstError = (backend as any).responseCompletionError;

    // A later connection.closed for the same turn must not replace the first outcome.
    (backend as any).handleProviderStreamTerminated('ACP connection closed');
    expect((backend as any).responseCompletionError).toBe(firstError);
  });
});

/**
 * The same contract exercised end to end against the *real* actionability predicate
 * and real timers, mirroring the independently reported reproduction: a prompt that is
 * actionable when the provider blocks, then claimed by a newer runtime while the
 * permission promise is still pending.
 */
class ClaimableSession {
  rpcHandlerManager = { handlers: new Map(), registerHandler(name: string, handler: unknown) { this.handlers.set(name, handler); } };
  agentState: any = { requests: {}, completedRequests: {} };
  getAgentStateSnapshot() { return this.agentState; }
  updateAgentState(updater: any) { this.agentState = updater(this.agentState); return this.agentState; }
}

class RealPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string { return '[StallBudget]'; }
  handleToolCall(toolCallId: string, toolName: string, input: unknown) {
    return this.requestPermissionDecision(toolCallId, toolName, input);
  }
}

describe('AcpBackend stall budget with the real permission predicate', () => {
  const REAL_STALL_MS = 40;

  beforeEach(() => {
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = String(REAL_STALL_MS);
  });

  afterEach(() => {
    delete process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS;
  });

  it('resumes and terminalizes when a newer runtime claims the request mid-wait', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-real', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-real');

    expect(handler.isPendingRequestActionable('perm-real')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, REAL_STALL_MS * 3));
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');

    session.agentState.requests['perm-real'] = {
      ...session.agentState.requests['perm-real'],
      [PERMISSION_RESPONSE_CLAIM_V1]: { runtimeId: 'newer-runtime' },
    };
    expect(handler.isPendingRequestActionable('perm-real')).toBe(false);

    // No further provider update and no permission response: the budget must resume.
    await new Promise((resolve) => setTimeout(resolve, REAL_STALL_MS * 3));
    const result = await observed;
    expect(result).toBeInstanceOf(Error);
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
    expect((backend as any).waitingForResponse).toBe(false);

    handler.reset();
  });
});

/**
 * Detecting that a prompt stopped being answerable must not cost a whole provider-stall
 * period. The provider budget bounds provider *silence* and is deliberately long; the
 * permission-actionability recheck bounds how long the user keeps seeing plain
 * "thinking" after the prompt became undeliverable. These are separate timings, so this
 * suite gives the stall budget a large value and asserts detection against the short
 * recheck interval only.
 */
describe('AcpBackend permission-actionability recheck', () => {
  const LONG_STALL_MS = 10_000;
  const RECHECK_MS = 50;

  beforeEach(() => {
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = String(LONG_STALL_MS);
    process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS = String(RECHECK_MS);
  });

  afterEach(() => {
    delete process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS;
    delete process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS;
  });

  async function waitForOutcome(observed: Promise<unknown>, budgetMs: number) {
    return Promise.race([
      observed,
      new Promise((resolve) => setTimeout(() => resolve('pending' as const), budgetMs)),
    ]);
  }

  it('terminalizes within the recheck interval, not the stall budget, when a claim lands', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-latency', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-latency');
    expect(handler.isPendingRequestActionable('perm-latency')).toBe(true);

    // Genuine actionable wait well past a whole stall budget: no deadline for a human.
    await new Promise((resolve) => setTimeout(resolve, LONG_STALL_MS / 4));
    expect(await waitForOutcome(observed, 10)).toBe('pending');

    session.agentState.requests['perm-latency'] = {
      ...session.agentState.requests['perm-latency'],
      [PERMISSION_RESPONSE_CLAIM_V1]: { runtimeId: 'newer-runtime' },
    };
    const lostAt = Date.now();

    const result = await waitForOutcome(observed, LONG_STALL_MS);
    const detectionMs = Date.now() - lostAt;

    expect(result).toBeInstanceOf(Error);
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
    // The exact acceptance bound: detection is governed by the recheck interval.
    expect(detectionMs).toBeLessThan(RECHECK_MS * 10);
    expect(detectionMs).toBeLessThan(LONG_STALL_MS / 4);

    handler.reset();
  });

  it('keeps a genuinely actionable prompt alive far beyond several stall budgets', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = '60';
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-patient', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-patient');

    // Many stall budgets and many recheck ticks of a real, answerable prompt.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await waitForOutcome(observed, 10)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
    expect((backend as any).lastTurnOutcome).toBeNull();

    handler.reset();
  });


  it('terminalizes promptly when the durable request disappears from agent state', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-gone', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-gone');
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 2));

    delete session.agentState.requests['perm-gone'];
    const lostAt = Date.now();

    const result = await waitForOutcome(observed, LONG_STALL_MS);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - lostAt).toBeLessThan(RECHECK_MS * 10);

    handler.reset();
  });

  it('does not fail a prompt that is answered while the recheck loop is running', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-answered', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-answered');
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 2));

    // The person answers: the waiter resolves and the backend ends the decision. The
    // request stops being actionable, but the turn must keep running normally.
    handler.reset();
    (backend as any).endPendingPermissionDecision('perm-answered');

    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 6));
    expect(await waitForOutcome(observed, 10)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
    expect((backend as any).permissionActionabilityTimer).toBeNull();
  });

  it('keeps running while a replacement prompt remains actionable and fails once none are', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const first = handler.handleToolCall('perm-first', 'Bash', { command: ['bash', '-lc', 'ls'] });
    first.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-first');
    const second = handler.handleToolCall('perm-second', 'Bash', { command: ['bash', '-lc', 'pwd'] });
    second.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-second');

    // The first prompt is superseded after it was a real, answerable question; the
    // second is still live, so the turn must keep running.
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 2));
    delete session.agentState.requests['perm-first'];
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 6));
    expect(await waitForOutcome(observed, 10)).toBe('pending');

    delete session.agentState.requests['perm-second'];
    const lostAt = Date.now();
    const result = await waitForOutcome(observed, LONG_STALL_MS);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - lostAt).toBeLessThan(RECHECK_MS * 10);

    handler.reset();
  });

  it('stops the recheck loop when the turn terminalizes for another reason first', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-cancelled', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-cancelled');
    expect((backend as any).permissionActionabilityTimer).not.toBeNull();

    // A connection close wins the terminal race while the prompt is still pending.
    (backend as any).handleProviderStreamTerminated('ACP connection closed');
    const firstOutcome = (backend as any).responseCompletionError;
    expect(await observed).toBeInstanceOf(Error);
    expect((backend as any).permissionActionabilityTimer).toBeNull();

    // The dead loop cannot resurrect a timer or replace the first terminal outcome.
    delete session.agentState.requests['perm-cancelled'];
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 6));
    expect((backend as any).permissionActionabilityTimer).toBeNull();
    expect((backend as any).responseCompletionError).toBe(firstOutcome);

    handler.reset();
  });


  it('never lets a stale prompt from a finished turn fail the next turn', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const firstWait = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    firstWait.catch(() => {});

    await sendUpdate(backend, 'turn one');
    const pending = handler.handleToolCall('perm-stale', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-stale');
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 2));

    // Turn one ends; the stale prompt is deliberately left registered and then loses
    // actionability after a new turn has already taken over the waiter.
    (backend as any).clearResponseCompletionTimeout();
    (backend as any).waitingForResponse = false;
    expect((backend as any).permissionActionabilityTimer).toBeNull();

    (backend as any).turnGeneration = 2;
    (backend as any).dispatchedPromptTurnGeneration = 2;
    (backend as any).pendingPromptResponseTurnGeneration = 2;
    (backend as any).waitingForResponse = true;
    const secondWait = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    secondWait.catch(() => {});

    delete session.agentState.requests['perm-stale'];
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS * 6));

    expect(await waitForOutcome(secondWait, 10)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);

    handler.reset();
  });

  it('stops the recheck timer once the permission resolves, leaving no live handle', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });

    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});

    await sendUpdate(backend, 'about to ask');
    const pending = handler.handleToolCall('perm-cleanup', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-cleanup');
    expect((backend as any).permissionActionabilityTimer).not.toBeNull();

    (backend as any).endPendingPermissionDecision('perm-cleanup');
    expect((backend as any).permissionActionabilityTimer).toBeNull();

    // Dispose must also be safe and idempotent with no pending decisions left.
    (backend as any).dispose();
    expect((backend as any).permissionActionabilityTimer).toBeNull();

    handler.reset();
  });
});

/**
 * Independently reproduced defects in the first recheck implementation.
 *
 * Both came from state that was global to the whole wait rather than owned by the thing
 * it describes: actionability history was global instead of per request, and stall
 * ownership (implicit budget versus an explicit caller ceiling) survived the wait that
 * established it. The timings below are the exact reported reproductions.
 */
describe('AcpBackend permission-actionability recheck ownership', () => {
  const STALL_MS = 1_000;
  const RECHECK_MS = 20;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function observe(promise: Promise<unknown>) {
    const observed = promise.then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});
    return observed;
  }

  async function settled(observed: Promise<unknown>) {
    return Promise.race([observed, sleep(5).then(() => 'pending' as const)]);
  }

  beforeEach(() => {
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = String(STALL_MS);
    process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS = String(RECHECK_MS);
  });

  afterEach(() => {
    delete process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS;
    delete process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS;
  });

  it('gives a replacement request the ordinary publication grace instead of inheriting the previous prompt', async () => {
    const actionable = new Set<string>(['perm-original']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-original');
    // Several rechecks observe a genuinely answerable prompt.
    await sleep(RECHECK_MS * 4);
    expect(await settled(observed)).toBe('pending');

    // The prompt is superseded by a replacement whose durable write has not landed yet.
    actionable.delete('perm-original');
    (backend as any).beginPendingPermissionDecision('perm-replacement');
    (backend as any).endPendingPermissionDecision('perm-original');
    const registeredAt = Date.now();

    // The replacement was never actionable, so it owns publication grace of its own and
    // must not be failed on the previous request's actionability history.
    await sleep(RECHECK_MS * 10);
    expect(await settled(observed)).toBe('pending');
    expect(Date.now() - registeredAt).toBeLessThan(STALL_MS);

    // It is still bounded: the ordinary stall budget remains its publication grace.
    const result = await Promise.race([observed, sleep(STALL_MS).then(() => 'pending' as const)]);
    expect(result).toBeInstanceOf(Error);
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
  });

  it('keeps a replacement alive once it publishes, without a fresh provider update', async () => {
    const actionable = new Set<string>(['perm-first']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-first');
    await sleep(RECHECK_MS * 3);

    actionable.delete('perm-first');
    (backend as any).beginPendingPermissionDecision('perm-second');
    (backend as any).endPendingPermissionDecision('perm-first');
    // Publication lands a few rechecks later; the person now owns the silence again.
    await sleep(RECHECK_MS * 3);
    actionable.add('perm-second');

    await sleep(STALL_MS * 2);
    expect(await settled(observed)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
  });

  it('never overrides an explicit caller timeout with a recheck armed by an earlier implicit wait', async () => {
    const actionable = new Set<string>(['perm-explicit']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn one');

    // Turn one ends, so its implicit stall ownership ends with it.
    (backend as any).clearResponseCompletionTimeout();
    (backend as any).waitingForResponse = false;
    expect((backend as any).responseCompletionStallIsImplicit).toBe(false);

    // A permission registers before the next wait arms its own budget.
    (backend as any).waitingForResponse = true;
    (backend as any).beginPendingPermissionDecision('perm-explicit');
    expect((backend as any).permissionActionabilityTimer).toBeNull();

    // The owner chooses an explicit ceiling; the recheck loop must stay out of it.
    const explicitWait = observe(backend.waitForResponseComplete(STALL_MS));
    const startedAt = Date.now();
    expect((backend as any).permissionActionabilityTimer).toBeNull();
    actionable.delete('perm-explicit');

    await sleep(RECHECK_MS * 10);
    expect(await settled(explicitWait)).toBe('pending');

    // The explicit ceiling is still the only thing that terminalizes this wait.
    const result = await Promise.race([explicitWait, sleep(STALL_MS).then(() => 'pending' as const)]);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(STALL_MS - RECHECK_MS);
  });

  it('does not suspend or shorten an explicit ceiling while an actionable prompt is pending', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: () => true,
      },
    });
    const explicitWait = observe(backend.waitForResponseComplete(STALL_MS / 4));
    const startedAt = Date.now();

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-owner-ceiling');
    expect((backend as any).permissionActionabilityTimer).toBeNull();

    const result = await Promise.race([explicitWait, sleep(STALL_MS).then(() => 'pending' as const)]);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(STALL_MS);
  });

  it('keeps an explicit null opt-out unbounded when a prompt stops being actionable', async () => {
    const actionable = new Set<string>(['perm-optout']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    const observed = observe(backend.waitForResponseComplete(null));

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-optout');
    await sleep(RECHECK_MS * 3);
    actionable.delete('perm-optout');

    await sleep(RECHECK_MS * 10);
    expect(await settled(observed)).toBe('pending');
    expect((backend as any).permissionActionabilityTimer).toBeNull();
    expect((backend as any).responseCompletionTimeout).toBeNull();
  });

  it('gives a request re-registered in a new turn generation fresh grace', async () => {
    const actionable = new Set<string>(['perm-reused']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });
    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn one');
    (backend as any).beginPendingPermissionDecision('perm-reused');
    await sleep(RECHECK_MS * 4);

    // Turn one ends with the prompt still registered, and it stops being actionable.
    (backend as any).clearResponseCompletionTimeout();
    (backend as any).waitingForResponse = false;
    actionable.delete('perm-reused');

    (backend as any).turnGeneration = 2;
    (backend as any).dispatchedPromptTurnGeneration = 2;
    (backend as any).pendingPromptResponseTurnGeneration = 2;
    (backend as any).waitingForResponse = true;
    const secondWait = observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn two');
    (backend as any).beginPendingPermissionDecision('perm-reused');

    // Turn two's registration is a new, unpublished request: it gets grace, not the
    // previous generation's actionability history.
    await sleep(RECHECK_MS * 10);
    expect(await settled(secondWait)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
  });
});

/**
 * Mixed pending sets: actionable, confirmed-lost and never-published requests at once.
 *
 * Independently reproduced: a never-published sibling explained the silence for the whole
 * turn, so a *different* request already proven lost could not terminalize it. Publication
 * grace belongs to the unpublished request alone; it never speaks for another request.
 *
 * The deterministic rule these cases pin down, evaluated per recheck over this turn's
 * pending requests: a request observed actionable and then unactionable on two
 * consecutive rechecks is confirmed lost, and the turn terminalizes as soon as any
 * request is confirmed lost and no request is currently actionable. A currently
 * actionable request always keeps the turn alive, because a person really can still
 * answer it; a never-published request only keeps its own ordinary stall-budget grace.
 */
describe('AcpBackend permission-actionability mixed pending sets', () => {
  const STALL_MS = 1_000;
  const RECHECK_MS = 20;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function observe(promise: Promise<unknown>) {
    const observed = promise.then(() => 'resolved' as const, (error: Error) => error);
    observed.catch(() => {});
    return observed;
  }

  async function settled(observed: Promise<unknown>) {
    return Promise.race([observed, sleep(5).then(() => 'pending' as const)]);
  }

  /** Waits for a terminal outcome without letting the stall budget mask the timing. */
  async function outcomeWithin(observed: Promise<unknown>, budgetMs: number) {
    return Promise.race([observed, sleep(budgetMs).then(() => 'pending' as const)]);
  }

  beforeEach(() => {
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = String(STALL_MS);
    process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS = String(RECHECK_MS);
  });

  afterEach(() => {
    delete process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS;
    delete process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS;
  });

  it('terminalizes a confirmed-lost request while a never-published sibling still holds its own grace', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });
    const observed = observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'about to ask');
    const live = handler.handleToolCall('perm-lost', 'Bash', { command: ['bash', '-lc', 'ls'] });
    live.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-lost');
    // Registered but never published to any client, and never actionable.
    (backend as any).beginPendingPermissionDecision('perm-unpublished');
    expect(handler.isPendingRequestActionable('perm-lost')).toBe(true);
    expect(handler.isPendingRequestActionable('perm-unpublished')).toBe(false);

    await sleep(RECHECK_MS * 4);
    expect(await settled(observed)).toBe('pending');

    delete session.agentState.requests['perm-lost'];
    const lostAt = Date.now();

    const result = await outcomeWithin(observed, STALL_MS * 2);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timeout waiting for response/i);
    expect((backend as any).lastTurnOutcome?.kind).toBe('failed');
    // Two rechecks, not a whole stall period spent as the sibling's grace.
    expect(Date.now() - lostAt).toBeLessThan(RECHECK_MS * 10);

    handler.reset();
  });

  it('keeps the turn alive when one request is lost while another is genuinely actionable', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });
    const observed = observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'about to ask');
    for (const id of ['perm-lost', 'perm-live']) {
      const pending = handler.handleToolCall(id, 'Bash', { command: ['bash', '-lc', 'ls'] });
      pending.catch(() => {});
      (backend as any).beginPendingPermissionDecision(id);
    }
    await sleep(RECHECK_MS * 4);

    // One prompt is gone for good, but the person is still looking at the other one, so
    // the provider is legitimately waiting and failing the turn would be a false failure.
    delete session.agentState.requests['perm-lost'];
    await sleep(STALL_MS * 2);
    expect(await settled(observed)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);

    // Answering the live prompt leaves only the request already proven lost.
    (backend as any).endPendingPermissionDecision('perm-live');
    const unexplainedAt = Date.now();
    const result = await outcomeWithin(observed, STALL_MS * 2);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - unexplainedAt).toBeLessThan(RECHECK_MS * 10);

    handler.reset();
  });

  it('fails once the last actionable request is lost, even with a never-published sibling pending', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });
    const observed = observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'about to ask');
    for (const id of ['perm-lost', 'perm-live']) {
      const pending = handler.handleToolCall(id, 'Bash', { command: ['bash', '-lc', 'ls'] });
      pending.catch(() => {});
      (backend as any).beginPendingPermissionDecision(id);
    }
    (backend as any).beginPendingPermissionDecision('perm-unpublished');
    await sleep(RECHECK_MS * 4);

    delete session.agentState.requests['perm-lost'];
    await sleep(RECHECK_MS * 6);
    expect(await settled(observed)).toBe('pending');

    delete session.agentState.requests['perm-live'];
    const unexplainedAt = Date.now();
    const result = await outcomeWithin(observed, STALL_MS * 2);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - unexplainedAt).toBeLessThan(RECHECK_MS * 10);

    handler.reset();
  });

  it('gives a never-yet-actionable request alone the ordinary publication grace', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });
    const observed = observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision('perm-unpublished');
    const registeredAt = Date.now();

    // No recheck may shorten publication grace for a request that was never answerable.
    await sleep(RECHECK_MS * 10);
    expect(await settled(observed)).toBe('pending');
    expect(Date.now() - registeredAt).toBeLessThan(STALL_MS);

    // It stays bounded by the ordinary stall budget rather than waiting forever.
    expect(await outcomeWithin(observed, STALL_MS * 2)).toBeInstanceOf(Error);

    handler.reset();
  });

  it('does not let an actionable prompt from a finished turn renew the next turn\'s stall budget', async () => {
    const session = new ClaimableSession();
    const handler = new RealPermissionHandler(session as any);
    const { backend } = createBackend({ permissionHandler: handler });
    observe(backend.waitForResponseComplete());

    await sendUpdate(backend, 'turn one');
    const pending = handler.handleToolCall('perm-stale', 'Bash', { command: ['bash', '-lc', 'ls'] });
    pending.catch(() => {});
    (backend as any).beginPendingPermissionDecision('perm-stale');
    expect(handler.isPendingRequestActionable('perm-stale')).toBe(true);

    // Turn one ends with the prompt still registered and still answerable.
    (backend as any).clearResponseCompletionTimeout();
    (backend as any).waitingForResponse = false;

    (backend as any).turnGeneration = 2;
    (backend as any).dispatchedPromptTurnGeneration = 2;
    (backend as any).pendingPromptResponseTurnGeneration = 2;
    (backend as any).waitingForResponse = true;
    const secondWait = observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn two');
    const startedAt = Date.now();

    // Turn two has no pending decision of its own, so the stale prompt must not renew
    // its budget at expiry: the same generation scope the recheck loop already uses.
    const result = await outcomeWithin(secondWait, STALL_MS * 3);
    expect(result).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(STALL_MS * 2);

    handler.reset();
  });
});
