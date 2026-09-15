import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
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

  it('does not expire the turn while a human permission decision is pending', async () => {
    const { backend } = createBackend();
    const observed = backend
      .waitForResponseComplete()
      .then(() => 'resolved' as const, (error: Error) => error);

    await sendUpdate(backend, 'about to ask');
    (backend as any).beginPendingPermissionDecision();

    // A human takes far longer than the stall budget to answer.
    await vi.advanceTimersByTimeAsync(STALL_MS * 4);
    expect(await Promise.race([observed, Promise.resolve('pending' as const)])).toBe('pending');

    // Resolving the decision re-arms the watchdog rather than leaving it suspended.
    (backend as any).endPendingPermissionDecision();
    await flush();
    expect((backend as any).responseCompletionTimeout).not.toBeNull();

    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    const result = await observed;
    expect(result).toBeInstanceOf(Error);
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
