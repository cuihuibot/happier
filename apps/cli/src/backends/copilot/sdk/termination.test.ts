/**
 * Provider-owned bounded termination for the SDK runtime.
 *
 * The shared ACP reset owner logs a dispose failure at debug and drops its
 * backend reference regardless, so a provider that merely rejects has no
 * retry and no visibility. ACP tolerates this because its backend force-kills
 * the process tree itself; the SDK backend must own the equivalent guarantee.
 *
 * The pinned SDK contract is: `stop()` resolves with an `Error[]` instead of
 * throwing, may also reject, and may never settle; `forceStop()` is the typed
 * escalation and SWALLOWS its own errors, so its resolution is NOT evidence
 * that the OS process exited.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warnings: string[] = [];

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn((message: unknown) => warnings.push(String(message))),
    warn: vi.fn((message: unknown) => warnings.push(String(message))),
    error: vi.fn((message: unknown) => warnings.push(String(message))),
  },
}));

type StopBehavior = 'clean' | 'errorArray' | 'throw' | 'never';

function createClientFixture(behavior: StopBehavior, forceStopBehavior: 'ok' | 'throw' = 'ok') {
  const calls = { stop: 0, forceStop: 0, disconnect: 0 };
  const session = {
    sessionId: 'native-1',
    send: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {
      calls.disconnect += 1;
    }),
  };
  const client = {
    start: vi.fn(async () => {}),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    stop: vi.fn(async () => {
      calls.stop += 1;
      if (behavior === 'clean') return [];
      if (behavior === 'errorArray') return [new Error('runtime shutdown timed out')];
      if (behavior === 'throw') throw new Error('stop rejected');
      return new Promise<never>(() => {});
    }),
    forceStop: vi.fn(async () => {
      calls.forceStop += 1;
      if (forceStopBehavior === 'throw') throw new Error('force stop rejected');
    }),
  };
  return { client, session, calls };
}

async function createBackend(client: unknown) {
  const mod = await import('./backend');
  const backend = mod.createCopilotSdkBackend({
    cliPath: '/fixture/copilot',
    directory: '/fixture/workdir',
    createClient: () => client as never,
    gracefulStopTimeoutMs: 20,
  } as never);
  await backend.startSession();
  return backend;
}

describe('copilot/sdk/backend bounded termination', () => {
  beforeEach(() => {
    warnings.length = 0;
    vi.clearAllMocks();
  });

  it('escalates to typed forceStop when graceful stop reports errors', async () => {
    const fixture = createClientFixture('errorArray');
    const backend = await createBackend(fixture.client);

    // A resolved escalation is an ATTEMPT, never observed exit, so the caller
    // is told the cleanup failed and the client stays retryable. Reporting this
    // as a successful dispose let the shared owner start a replacement runtime
    // on top of a native process that may still be alive.
    await expect(backend.dispose()).rejects.toThrow(/cleanup failed/);

    expect(fixture.calls.stop).toBe(1);
    expect(fixture.calls.forceStop).toBe(1);
    expect(backend.getLastShutdownOutcome().processExitObserved).toBe(false);
    expect(backend.reportsVerifiedTermination()).toBe(false);
    expect(warnings.some((line) => /cleanup/i.test(line))).toBe(true);
  });

  it('escalates to typed forceStop when graceful stop rejects', async () => {
    const fixture = createClientFixture('throw');
    const backend = await createBackend(fixture.client);

    await expect(backend.dispose()).rejects.toThrow(/cleanup failed/);

    expect(fixture.calls.forceStop).toBe(1);
    expect(warnings.some((line) => /cleanup/i.test(line))).toBe(true);
  });

  it('escalates on a never-settling graceful stop instead of hanging cleanup', async () => {
    const fixture = createClientFixture('never');
    const backend = await createBackend(fixture.client);

    await expect(backend.dispose()).rejects.toThrow(/cleanup failed/);

    expect(fixture.calls.forceStop).toBe(1);
    expect(warnings.some((line) => /cleanup/i.test(line))).toBe(true);
  });

  it('reports the aggregated cleanup failure on a default-on signal before returning', async () => {
    const fixture = createClientFixture('errorArray');
    const backend = await createBackend(fixture.client);

    await backend.dispose().catch(() => {});

    // The provider must make the failure visible on a default-on signal in its
    // own right: the shared reset owner re-raises only a sanitized envelope, so
    // the phase and diagnostic-code detail exists nowhere else.
    expect(warnings.some((line) => /cleanup/i.test(line))).toBe(true);
  });

  it('never reports termination as verified when only forceStop resolved', async () => {
    const fixture = createClientFixture('errorArray');
    const backend = await createBackend(fixture.client);

    await backend.dispose().catch(() => {});

    // forceStop swallows kill errors, so resolution is not observed process exit.
    const outcome = backend.getLastShutdownOutcome();
    expect(outcome.escalatedToForceStop).toBe(true);
    expect(outcome.gracefulStopSucceeded).toBe(false);
    expect(outcome.processExitObserved).toBe(false);
  });

  it('keeps a failed cleanup retryable instead of latching disposed', async () => {
    const fixture = createClientFixture('errorArray');
    const backend = await createBackend(fixture.client);

    await backend.dispose().catch(() => {});
    await backend.dispose().catch(() => {});

    // Retry stays reachable for every unverified cleanup, including one whose
    // forced escalation RESOLVED: a resolved forceStop that did not actually
    // kill the runtime must still be retryable through the same handle.
    expect(fixture.calls.stop).toBe(2);
  });

  it('does not escalate or warn when graceful stop succeeds', async () => {
    const fixture = createClientFixture('clean');
    const backend = await createBackend(fixture.client);

    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(fixture.calls.forceStop).toBe(0);
    expect(warnings.some((line) => /cleanup/i.test(line))).toBe(false);
    expect(backend.getLastShutdownOutcome().gracefulStopSucceeded).toBe(true);
  });

  it('still surfaces failure when the escalation itself fails', async () => {
    const fixture = createClientFixture('throw', 'throw');
    const backend = await createBackend(fixture.client);

    await expect(backend.dispose()).rejects.toThrow(/cleanup/i);
    expect(fixture.calls.forceStop).toBe(1);
    expect(backend.getLastShutdownOutcome().forceStopSucceeded).toBe(false);
  });

  it('classifies a cleanup failure as a failure, never a cancellation', async () => {
    const { isAbortLikeError } = await import('@/agent/executionRuns/runtime/turnDelivery');
    const fixture = createClientFixture('throw');
    const backend = await createBackend(fixture.client);

    const error = await backend.dispose().catch((e: unknown) => e);

    // The aggregated text mentions aborting/stopping; it must not be reclassified.
    expect(isAbortLikeError(error)).toBe(false);
  });
});
