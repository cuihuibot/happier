import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';

/**
 * Regression cover for the abort-corridor starvation deadlock.
 *
 * `runStandardAcpProvider.handleAbort` calls `abortController.abort()` and only
 * installs a replacement controller in the `finally` after `await
 * runtime.cancel()`. While that abort is in flight the prompt loop still sees
 * the aborted signal, `waitForNextInput` returns `null` immediately, and the
 * loop's `if (!next) continue` re-enters at once.
 *
 * That re-entry is a pure microtask cycle: it never yields to the macrotask
 * queue. The abort corridor's own 10,000 ms flush budget is a `setTimeout`, so
 * the spin prevents the bound that would end the abort from ever firing, which
 * in turn prevents the replacement controller from being installed. The loop is
 * therefore not merely busy, it is deadlocked against the corridor, and the
 * observed consequence is unbounded promise allocation until the host dies.
 */
function createModeQueue() {
  return new MessageQueue2<{ permissionMode: any }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

function createLoopRuntime() {
  return {
    getSessionId: () => null,
    isTurnInFlight: () => false,
    sendPrompt: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    flushTurn: vi.fn(async () => {}),
    beginTurn: vi.fn(() => {}),
    failTurn: vi.fn(async () => false),
    isProviderNativeCommand: vi.fn(async () => false),
  } as any;
}

describe('permission mode prompt loop: abort-window starvation', () => {
  it('lets a scheduled macrotask run while the abort signal is still aborted', async () => {
    const queue = createModeQueue();
    const session = createMutableApiSessionClientFixture();
    const runtime = createLoopRuntime();

    // Exactly the production shape: the controller is aborted and its
    // replacement is only installed once the abort corridor completes.
    const abortController = new AbortController();
    abortController.abort();

    let shouldExit = false;
    let timerFired = false;

    // Stands in for the corridor's own bounded timer. On the defect this never
    // runs, because the loop starves the macrotask queue.
    const timer = setTimeout(() => {
      timerFired = true;
      shouldExit = true;
    }, 10);

    // The loop must not be allowed to run away if the defect is present.
    let nullBatchIterations = 0;
    const iterationCap = 20_000;
    const inputConsumer = {
      async waitForNextInput() {
        nullBatchIterations += 1;
        if (nullBatchIterations >= iterationCap) shouldExit = true;
        // Real behaviour of the actual consumer under an aborted signal; the
        // companion test below pins that this is what it really returns.
        return null;
      },
      runProviderInputDispatch: async () => undefined,
      closeProviderInputAdmissionAndWaitForDispatches: async () => undefined,
    } as any;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session: session as any,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime,
      inputConsumer,
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => {},
        flushPendingAfterStart: async () => {},
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
    } as any);

    clearTimeout(timer);

    expect(timerFired).toBe(true);
    expect(nullBatchIterations).toBeLessThan(iterationCap);
  });

  it('pins that the real input consumer returns null once the signal is aborted', async () => {
    const queue = createModeQueue();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        materializeNextPendingMessageSafely: async () => null,
        shouldAttemptPendingMaterialization: () => true,
        reconcilePendingQueueState: async () => {},
        waitForPendingEligibilityUpdate: async () => {},
      },
      reconcileWhenEmpty: 'skip',
    } as any);

    const controller = new AbortController();
    controller.abort();

    await expect(consumer.waitForNextInput({ abortSignal: controller.signal })).resolves.toBeNull();
  });
});
