import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Repair coverage for QF-AC-003.
 *
 * Observed live on the native v4 candidate: an authenticated abort issued during an unresolved
 * real provider tool call never acknowledged, the runtime process pinned several cores, stopped
 * writing logs and stopped sending keep-alives, and the next prompt for the same session stayed
 * pending forever.
 *
 * The cause is a livelock, not a blocked network await. `waitForNextInput()` returns `null`
 * immediately while the abort signal is aborted, and the loop used to `continue` straight back
 * into the wait. The signal stays aborted until the abort handler finishes, and the abort
 * handler needs the event loop that the loop's own microtask spin was starving.
 */

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: any; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

function createLoopRuntime(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    beginTurn: vi.fn(),
    startOrLoad: vi.fn(async () => {}),
    sendPrompt: vi.fn(async (_message: string) => {}),
    flushTurn: vi.fn(),
    reset: vi.fn(async () => {}),
    getSessionId: vi.fn(() => 'vendor-session'),
    ...overrides,
  };
}

function runLoop(opts: {
  runtime: ReturnType<typeof createLoopRuntime>;
  queue: ReturnType<typeof createModeQueue>;
  getAbortSignal: () => AbortSignal;
  waitForAbortSettled?: () => Promise<void>;
  shouldExit: () => boolean;
  inputConsumer?: unknown;
  sendReady?: () => void;
}): Promise<void> {
  const session = createMutableApiSessionClientFixture();
  session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }) as never);
  return runPermissionModePromptLoop({
    providerName: 'Test Provider',
    agentMessageType: 'qwen',
    explicitPermissionMode: undefined,
    session: session as never,
    messageQueue: opts.queue,
    permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as never,
    runtime: opts.runtime as never,
    createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
    messageBuffer: new MessageBuffer(),
    shouldExit: opts.shouldExit,
    getAbortSignal: opts.getAbortSignal,
    ...(opts.waitForAbortSettled ? { waitForAbortSettled: opts.waitForAbortSettled } : {}),
    ...(opts.inputConsumer ? { inputConsumer: opts.inputConsumer as never } : {}),
    keepAlive: () => {},
    setThinking: () => {},
    sendReady: opts.sendReady ?? (() => {}),
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => {},
    setCurrentPermissionModeUpdatedAt: () => {},
    formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
  } as never);
}

/**
 * An input consumer that behaves exactly like the real one under an aborted signal: it returns
 * `null` immediately without ever awaiting anything the event loop has to service.
 *
 * The spin cap is a test-side escape hatch only. Without it the livelock starves this process
 * too, so the test would hang instead of failing.
 */
function createAbortAwareInputConsumer(getSignal: () => AbortSignal, onSpinCap: () => void) {
  const SPIN_CAP = 20_000;
  const stats = { waits: 0, spinCapped: false };
  return {
    stats,
    consumer: {
      waitForNextInput: async () => {
        stats.waits += 1;
        if (stats.waits >= SPIN_CAP) {
          stats.spinCapped = true;
          onSpinCap();
          return null;
        }
        if (getSignal().aborted) return null;
        // Park until the test ends; a real consumer waits for a wake signal here.
        await new Promise<void>((resolve) => { setTimeout(resolve, 10_000); });
        return null;
      },
      drainPending: async () => {},
      runProviderInputDispatch: async (dispatchOpts: { dispatch: () => Promise<unknown> }) => ({
        status: 'completed' as const,
        value: await dispatchOpts.dispatch(),
      }),
    },
  };
}

describe('prompt loop cancellation livelock', () => {
  it('waits for the abort to settle instead of spinning on an aborted signal', async () => {
    const controller = new AbortController();
    let shouldExit = false;
    let abortSettled = false;
    const input = createAbortAwareInputConsumer(() => controller.signal, () => { shouldExit = true; });

    controller.abort();
    const loop = runLoop({
      runtime: createLoopRuntime(),
      queue: createModeQueue(),
      getAbortSignal: () => controller.signal,
      // Stands in for the real abort handler: it can only finish if the event loop runs.
      waitForAbortSettled: async () => {
        await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
        abortSettled = true;
      },
      shouldExit: () => shouldExit,
      inputConsumer: input.consumer,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
    shouldExit = true;
    await Promise.race([loop, new Promise<void>((resolve) => { setTimeout(resolve, 1_000); })]);

    expect(input.stats.spinCapped, 'the loop busy-spun on the aborted signal').toBe(false);
    expect(abortSettled, 'a macrotask timer must still fire while the loop waits').toBe(true);
    expect(
      input.stats.waits,
      `the loop must not busy-spin on an aborted signal (observed ${input.stats.waits} waits in 150ms)`,
    ).toBeLessThan(60);
  });

  it('keeps yielding the event loop even without an abort-settled hook', async () => {
    const controller = new AbortController();
    let shouldExit = false;
    const input = createAbortAwareInputConsumer(() => controller.signal, () => { shouldExit = true; });
    controller.abort();

    const loop = runLoop({
      runtime: createLoopRuntime(),
      queue: createModeQueue(),
      getAbortSignal: () => controller.signal,
      shouldExit: () => shouldExit,
      inputConsumer: input.consumer,
    });

    let timerFired = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => { timerFired = true; resolve(); }, 100);
    });
    shouldExit = true;
    await Promise.race([loop, new Promise<void>((resolve) => { setTimeout(resolve, 1_000); })]);

    expect(input.stats.spinCapped, 'the loop busy-spun on the aborted signal').toBe(false);
    expect(timerFired, 'timers must still fire, so keep-alives and I/O survive an abort').toBe(true);
    expect(input.stats.waits).toBeLessThan(400);
  });

  it('reopens a provider session that the cancellation fallback closed', async () => {
    const controller = new AbortController();
    let providerConnectionForceClosed = false;
    const runtime = createLoopRuntime({ isProviderConnectionForceClosed: () => providerConnectionForceClosed });
    const queue = createModeQueue();
    let shouldExit = false;
    let readyCount = 0;

    queue.push({ text: 'first', localId: 'local-1' } as never, { permissionMode: 'default' });
    const loop = runLoop({
      runtime,
      queue,
      getAbortSignal: () => controller.signal,
      shouldExit: () => shouldExit,
      sendReady: () => {
        readyCount += 1;
        if (readyCount === 1) {
          // The bounded cancellation fallback closed the provider connection.
          providerConnectionForceClosed = true;
          queue.push({ text: 'after cancel', localId: 'local-2' } as never, { permissionMode: 'default' });
          return;
        }
        shouldExit = true;
      },
    });
    await Promise.race([loop, new Promise<void>((resolve) => { setTimeout(resolve, 5_000); })]);

    expect(runtime.reset, 'a closed provider session must be reset, not stranded').toHaveBeenCalled();
    expect(
      runtime.startOrLoad.mock.calls.length,
      'the session must be reopened so the next prompt can be answered',
    ).toBeGreaterThan(1);
    expect(runtime.sendPrompt.mock.calls.map((call: unknown[]) => call[0])).toContain('after cancel');
  });
});
