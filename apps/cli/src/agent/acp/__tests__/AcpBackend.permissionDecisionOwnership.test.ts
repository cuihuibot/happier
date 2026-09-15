import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '@/agent/core/AgentMessage';

/**
 * Registration-scoped ownership of a pending permission decision.
 *
 * Independently reproduced: `endPendingPermissionDecision()` took only a request id and
 * deleted whatever the map held for it. A prompt answered — or abandoned — in an older
 * turn therefore deleted a *newer* registration that happened to reuse the same request
 * id, which silently stopped the recheck loop, dropped the current turn's canonical view
 * of its own prompt and put a stall deadline on a person who was still being asked.
 *
 * The rule these cases pin down: registration identity, not the request id, owns removal.
 * Only the exact registration returned by `beginPendingPermissionDecision()` may remove
 * itself; a stale or superseded finalizer is a strict no-op that deletes nothing, stops
 * and restarts no timer, and leaves every newer piece of state untouched.
 */

const SESSION_ID = 'sess_permission_ownership';

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
  (backend as any).turnGeneration = 1;
  (backend as any).dispatchedPromptTurnGeneration = 1;
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

/** The exact state the defect corrupted, read straight from the backend. */
function snapshot(backend: AcpBackend, requestId: string) {
  return {
    entry: (backend as any).pendingPermissionDecisions.get(requestId) ?? null,
    current: (backend as any).hasCurrentTurnPendingPermissionDecision(),
    timer: (backend as any).permissionActionabilityTimer !== null,
  };
}

/** Moves the backend to the next turn generation exactly as a new prompt turn does. */
function advanceTurnGeneration(backend: AcpBackend, generation: number): void {
  (backend as any).clearResponseCompletionTimeout();
  (backend as any).waitingForResponse = false;
  (backend as any).turnGeneration = generation;
  (backend as any).closedTurnGeneration = null;
  (backend as any).pendingTurnOutcome = null;
  (backend as any).lastTurnOutcome = null;
  (backend as any).responseCompletionError = null;
  (backend as any).dispatchedPromptTurnGeneration = generation;
  (backend as any).pendingPromptResponseTurnGeneration = generation;
  (backend as any).waitingForResponse = true;
}

describe('AcpBackend pending permission decision ownership', () => {
  const STALL_MS = 80;
  const RECHECK_MS = 20;

  beforeEach(() => {
    process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS = String(STALL_MS);
    process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS = String(RECHECK_MS);
  });

  afterEach(() => {
    delete process.env.HAPPIER_ACP_RESPONSE_COMPLETION_STALL_MS;
    delete process.env.HAPPIER_ACP_PERMISSION_RECHECK_MS;
  });

  it('ignores a stale prior-generation finalizer for a reused request id', async () => {
    const actionable = new Set<string>(['perm-reused']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });

    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn one asks');
    const generation1 = (backend as any).beginPendingPermissionDecision('perm-reused');

    advanceTurnGeneration(backend, 2);
    const secondWait = observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn two asks');
    const generation2 = (backend as any).beginPendingPermissionDecision('perm-reused');

    expect(generation2).not.toBe(generation1);
    const before = snapshot(backend, 'perm-reused');
    expect(before.entry).toBe(generation2);
    expect(before.current).toBe(true);
    expect(before.timer).toBe(true);

    // Turn one's handler finally unwinds and runs its `finally` for the same id.
    (backend as any).endPendingPermissionDecision('perm-reused', generation1);

    const after = snapshot(backend, 'perm-reused');
    expect(after.entry).toBe(generation2);
    expect(after.current).toBe(true);
    expect(after.timer).toBe(true);

    // The person asked in turn two is still being asked, so the turn keeps waiting.
    await sleep(STALL_MS * 3);
    expect(await settled(secondWait)).toBe('pending');
    expect((backend as any).waitingForResponse).toBe(true);
  });

  it('keeps one registration per request id within a generation and lets it finalize', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: () => true,
      },
    });

    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'about to ask');
    const first = (backend as any).beginPendingPermissionDecision('perm-same-turn');
    const second = (backend as any).beginPendingPermissionDecision('perm-same-turn');

    expect(second).toBe(first);
    expect(snapshot(backend, 'perm-same-turn').entry).toBe(first);

    (backend as any).endPendingPermissionDecision('perm-same-turn', second);
    const after = snapshot(backend, 'perm-same-turn');
    expect(after.entry).toBeNull();
    expect(after.current).toBe(false);
    expect(after.timer).toBe(false);
  });

  it('treats a second finalizer for the same registration as a no-op', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: () => true,
      },
    });

    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'about to ask');
    const registration = (backend as any).beginPendingPermissionDecision('perm-twice');
    (backend as any).endPendingPermissionDecision('perm-twice', registration);
    expect(snapshot(backend, 'perm-twice').entry).toBeNull();

    // A replacement registers, and only then does the first finalizer run again.
    const replacement = (backend as any).beginPendingPermissionDecision('perm-twice');
    expect(replacement).not.toBe(registration);
    (backend as any).endPendingPermissionDecision('perm-twice', registration);

    const after = snapshot(backend, 'perm-twice');
    expect(after.entry).toBe(replacement);
    expect(after.current).toBe(true);
    expect(after.timer).toBe(true);
  });

  it('never resurrects or disturbs state when a finalizer runs after a reset', async () => {
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: () => true,
      },
    });

    const observed = observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'about to ask');
    const registration = (backend as any).beginPendingPermissionDecision('perm-cancelled');
    expect(snapshot(backend, 'perm-cancelled').timer).toBe(true);

    // The turn is cancelled: pending decisions are dropped and the recheck loop stops.
    (backend as any).pendingPermissionDecisions.clear();
    (backend as any).stopPermissionActionabilityRecheck();
    (backend as any).failPendingResponseWait(new Error('Cancelled by user'));
    const outcome = await settled(observed);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('Cancelled by user');

    (backend as any).endPendingPermissionDecision('perm-cancelled', registration);

    const after = snapshot(backend, 'perm-cancelled');
    expect(after.entry).toBeNull();
    expect(after.current).toBe(false);
    expect(after.timer).toBe(false);
    expect((backend as any).responseCompletionTimeout).toBeNull();

    // The next turn asks the same question again; the dropped finalizer still owns nothing.
    advanceTurnGeneration(backend, 2);
    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn two asks again');
    const reasked = (backend as any).beginPendingPermissionDecision('perm-cancelled');
    (backend as any).endPendingPermissionDecision('perm-cancelled', registration);

    const reasserted = snapshot(backend, 'perm-cancelled');
    expect(reasserted.entry).toBe(reasked);
    expect(reasserted.current).toBe(true);
    expect(reasserted.timer).toBe(true);
  });

  it('lets the current registration finalize across a generation rollover', async () => {
    const actionable = new Set<string>(['perm-rollover']);
    const { backend } = createBackend({
      permissionHandler: {
        handleToolCall: () => new Promise<never>(() => {}),
        isPendingRequestActionable: (id: string) => actionable.has(id),
      },
    });

    observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn one asks');
    const generation1 = (backend as any).beginPendingPermissionDecision('perm-rollover');

    advanceTurnGeneration(backend, 2);
    const secondWait = observe(backend.waitForResponseComplete());
    await sendUpdate(backend, 'turn two asks');
    const generation2 = (backend as any).beginPendingPermissionDecision('perm-rollover');

    // The stale finalizer changes nothing; the current one still owns removal.
    (backend as any).endPendingPermissionDecision('perm-rollover', generation1);
    expect(snapshot(backend, 'perm-rollover').entry).toBe(generation2);

    (backend as any).endPendingPermissionDecision('perm-rollover', generation2);
    const after = snapshot(backend, 'perm-rollover');
    expect(after.entry).toBeNull();
    expect(after.current).toBe(false);
    expect(after.timer).toBe(false);

    // With no prompt left to explain the silence the ordinary stall budget applies again.
    const result = await Promise.race([
      secondWait,
      sleep(STALL_MS * 6).then(() => 'pending' as const),
    ]);
    expect(result).toBeInstanceOf(Error);
  });
});
