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

    // The first prompt is superseded, but the second is still a real question.
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
