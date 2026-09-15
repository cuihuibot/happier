/**
 * Regression tests for the Copilot SDK backend's whole-turn settlement deadline.
 *
 * `waitForResponseComplete()` armed a single non-refreshed `setTimeout`, so the
 * default 60s settlement bound was an ABSOLUTE ceiling on turn length rather
 * than a bound on native inactivity. A healthy turn that kept emitting native
 * events was aborted at 60s purely for taking too long.
 *
 * The bound must instead be progress-aware: native events refresh it, an
 * outstanding permission request suspends it, an explicit `0`/`null` opts out,
 * and genuine inactivity still terminalizes deterministically.
 *
 * The only mocked boundary is the pinned `@github/copilot-sdk` client, a genuine
 * external process/transport adapter. Settlement logic under test is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PermissionDecision = { kind: 'approve' } | { kind: 'reject'; feedback: string };

function createFakeSdk() {
  const listeners: ((event: unknown) => void)[] = [];
  const calls = { abort: 0 };
  let onPermissionRequest:
    | ((request: unknown) => Promise<PermissionDecision>)
    | null = null;

  const session = {
    sessionId: 'native-session-1',
    send: vi.fn(async () => 'req-1'),
    abort: vi.fn(async () => {
      calls.abort += 1;
    }),
    disconnect: vi.fn(async () => {}),
  };

  const capture = (config: Record<string, unknown>) => {
    if (typeof config.onEvent === 'function') {
      listeners.push(config.onEvent as (event: unknown) => void);
    }
    if (typeof config.onPermissionRequest === 'function') {
      onPermissionRequest = config.onPermissionRequest as typeof onPermissionRequest;
    }
  };

  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => [] as Error[]),
    createSession: vi.fn(async (config: Record<string, unknown>) => {
      capture(config);
      return session;
    }),
    resumeSession: vi.fn(async (sessionId: string, config: Record<string, unknown>) => {
      capture(config);
      return { ...session, sessionId };
    }),
  };

  return {
    client,
    calls,
    emit: (type: string, data: Record<string, unknown> = {}) => {
      for (const listener of [...listeners]) listener({ type, data });
    },
    requestPermission: async () => {
      if (!onPermissionRequest) throw new Error('no permission bridge captured');
      return onPermissionRequest({ toolName: 'bash', arguments: { command: 'ls' } });
    },
  };
}

async function buildBackend(overrides: Record<string, unknown> = {}) {
  const sdk = createFakeSdk();
  const mod = await import('./backend');
  const backend = mod.createCopilotSdkBackend({
    cliPath: '/fixture/copilot',
    directory: '/fixture/workdir',
    createClient: () => sdk.client as never,
    ...overrides,
  } as never);
  return { backend, sdk };
}

/**
 * Tracks settlement without racing: a `Promise.race` against an already-resolved
 * sentinel reports 'pending' for a promise that settled in the same tick.
 */
function track(wait: Promise<unknown>) {
  let status = 'pending';
  let error: Error | null = null;
  wait.then(
    () => {
      status = 'resolved';
    },
    (cause: Error) => {
      status = 'rejected';
      error = cause;
    },
  );
  return {
    async status(): Promise<string> {
      await Promise.resolve();
      await Promise.resolve();
      return status;
    },
    error(): Error | null {
      return error;
    },
  };
}

const STALL_MS = 1_000;

describe('copilot SDK backend settlement stall budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('does not abort a turn that keeps making native progress past 60 and 90 seconds', async () => {
    const { backend, sdk } = await buildBackend({ settlementTimeoutMs: STALL_MS });
    await backend.startSession();
    await backend.sendPrompt('s', 'prompt');

    const wait = backend.waitForResponseComplete();
    const tracked = track(wait);

    // 90 simulated seconds of steady native progress, each gap inside the budget.
    for (let elapsed = 0; elapsed < 90_000; elapsed += STALL_MS / 2) {
      await vi.advanceTimersByTimeAsync(STALL_MS / 2);
      sdk.emit('assistant.message', { content: `chunk-${elapsed}` });
    }

    expect(await tracked.status()).toBe('pending');
    expect(sdk.calls.abort).toBe(0);

    // The turn still ends normally on a genuine idle.
    sdk.emit('session.idle', { mode: 'interactive' });
    await expect(wait).resolves.toBeUndefined();
  });

  it('still terminalizes deterministically on genuine native inactivity', async () => {
    const { backend, sdk } = await buildBackend({ settlementTimeoutMs: STALL_MS });
    await backend.startSession();
    await backend.sendPrompt('s', 'prompt');

    const wait = backend.waitForResponseComplete();
    const tracked = track(wait);
    const observed = wait.then(
      () => null,
      (error: Error) => error,
    );

    sdk.emit('assistant.message', { content: 'last sign of life' });
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(await tracked.status()).toBe('pending');

    await vi.advanceTimersByTimeAsync(2);
    const error = await observed;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/timed out/i);
    expect(sdk.calls.abort).toBe(1);
  });

  it('does not expire the turn while a native permission request is outstanding', async () => {
    let releaseDecision: (decision: PermissionDecision) => void = () => {};
    const decision = new Promise<PermissionDecision>((resolve) => {
      releaseDecision = resolve;
    });

    const { backend, sdk } = await buildBackend({
      settlementTimeoutMs: STALL_MS,
      onPermissionRequest: async () => decision,
    });
    await backend.startSession();
    await backend.sendPrompt('s', 'prompt');

    const wait = backend.waitForResponseComplete();
    const tracked = track(wait);

    const permission = sdk.requestPermission();
    await Promise.resolve();

    // A person taking far longer than the budget is not native inactivity.
    await vi.advanceTimersByTimeAsync(STALL_MS * 10);
    expect(await tracked.status()).toBe('pending');
    expect(sdk.calls.abort).toBe(0);

    releaseDecision({ kind: 'approve' });
    await permission;
    await vi.advanceTimersByTimeAsync(0);

    // Resolution re-arms the budget rather than leaving the turn unbounded.
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    // Expiry latches the failure, then joins the bounded abort stage before it rejects.
    await vi.advanceTimersByTimeAsync(10);
    expect(await tracked.status()).toBe('rejected');
    expect(sdk.calls.abort).toBe(1);
  });

  it('treats an explicit 0 or null as an unbounded opt-out', async () => {
    for (const optOut of [0, null] as const) {
      const { backend, sdk } = await buildBackend({ settlementTimeoutMs: STALL_MS });
      await backend.startSession();
      await backend.sendPrompt('s', 'prompt');

      const wait = backend.waitForResponseComplete(optOut);
      const tracked = track(wait);

      await vi.advanceTimersByTimeAsync(STALL_MS * 50);
      expect(await tracked.status()).toBe('pending');
      expect(sdk.calls.abort).toBe(0);
    }
  });

  it('keeps an explicit caller-supplied timeout as a hard ceiling', async () => {
    const { backend, sdk } = await buildBackend({ settlementTimeoutMs: STALL_MS });
    await backend.startSession();
    await backend.sendPrompt('s', 'prompt');

    const wait = backend.waitForResponseComplete(50);
    const observed = wait.then(
      () => null,
      (error: Error) => error,
    );

    // Progress must NOT extend a ceiling the owner chose explicitly: cancellation
    // and cleanup paths depend on it firing.
    await vi.advanceTimersByTimeAsync(30);
    sdk.emit('assistant.message', { content: 'progress' });
    await vi.advanceTimersByTimeAsync(40);

    const error = await observed;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/timed out/i);
  });
});
