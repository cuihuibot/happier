/**
 * Owned-process termination evidence, using a real disposable child process.
 *
 * The SDK's `forceStop()` swallows kill errors, so a fault-injected promise
 * fixture can never show that an OS process actually exited. This test supplies
 * the missing half offline: it spawns a genuine long-lived child, records its
 * OWN pid, and proves the escalation sequence really removes that exact process.
 *
 * Scope, stated honestly: this is a generic child process, NOT the native
 * Copilot runtime. It proves the termination mechanism and the owned-PID
 * evidence method. It does not prove the SDK's internal shutdown behavior, which
 * needs a live native scenario that is not authorized.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const spawned: ChildProcess[] = [];

/** Spawns a real child that ignores SIGTERM, so graceful stop provably fails. */
function spawnStubbornChild(): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    { stdio: 'ignore' },
  );
  spawned.push(child);
  return child;
}

function spawnCooperativeChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
  spawned.push(child);
  return child;
}

/** Liveness by exact recorded pid; never by process name. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Mirrors the provider's termination sequence against a real process:
 * bounded graceful stop, then hard escalation, then verified exit.
 */
async function terminateOwnedChild(
  child: ChildProcess,
  gracefulTimeoutMs: number,
): Promise<{ escalated: boolean; processExitObserved: boolean }> {
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('owned child has no pid');

  child.kill('SIGTERM');
  if (await waitForExit(child, gracefulTimeoutMs)) {
    return { escalated: false, processExitObserved: !isPidAlive(pid) };
  }

  child.kill('SIGKILL');
  const exited = await waitForExit(child, 5_000);
  return { escalated: true, processExitObserved: exited && !isPidAlive(pid) };
}

describe('owned child process termination evidence', () => {
  it('verifies exit of a cooperative owned process without escalating', async () => {
    const child = spawnCooperativeChild();
    const pid = child.pid!;
    expect(isPidAlive(pid)).toBe(true);

    const outcome = await terminateOwnedChild(child, 3_000);

    expect(outcome.escalated).toBe(false);
    expect(outcome.processExitObserved).toBe(true);
    expect(isPidAlive(pid)).toBe(false);
  });

  it('escalates and still verifies exit when graceful termination is ignored', async () => {
    const child = spawnStubbornChild();
    const pid = child.pid!;
    // Give the child time to install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(isPidAlive(pid)).toBe(true);

    const outcome = await terminateOwnedChild(child, 500);

    // Graceful stop provably failed; escalation is what removed the process.
    expect(outcome.escalated).toBe(true);
    expect(outcome.processExitObserved).toBe(true);
    expect(isPidAlive(pid)).toBe(false);
  }, 15_000);

  it('reports liveness for the exact recorded pid only', async () => {
    const first = spawnCooperativeChild();
    const second = spawnCooperativeChild();
    const firstPid = first.pid!;
    const secondPid = second.pid!;
    expect(firstPid).not.toBe(secondPid);

    await terminateOwnedChild(first, 3_000);

    // Terminating one owned process must not be read as terminating a sibling.
    expect(isPidAlive(firstPid)).toBe(false);
    expect(isPidAlive(secondPid)).toBe(true);

    await terminateOwnedChild(second, 3_000);
    expect(isPidAlive(secondPid)).toBe(false);
  }, 15_000);

  it('leaves no owned child alive at the end of the scenario', async () => {
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        await terminateOwnedChild(child, 1_000);
      }
    }
    const survivors = spawned
      .map((child) => child.pid)
      .filter((pid): pid is number => typeof pid === 'number' && isPidAlive(pid));
    expect(survivors).toEqual([]);
  }, 20_000);
});
