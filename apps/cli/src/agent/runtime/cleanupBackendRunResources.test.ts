import { describe, expect, it, vi } from 'vitest';

import { cleanupBackendRunResources } from './cleanupBackendRunResources';

vi.mock('@/integrations/caffeinate', () => ({ stopCaffeinate: vi.fn() }));

function opts(resetRuntime: () => Promise<void>) {
  const unmountUi = vi.fn();
  const stopMcpServer = vi.fn();
  const cancel = vi.fn();
  return {
    args: {
      keepAliveInterval: setInterval(() => {}, 60_000),
      reconnectionHandle: { cancel },
      stopMcpServer,
      resetRuntime,
      unmountUi,
    },
    unmountUi,
    stopMcpServer,
    cancel,
  };
}

describe('cleanupBackendRunResources', () => {
  it('releases every local resource and reports success when the runtime reset succeeds', async () => {
    const o = opts(async () => {});
    await cleanupBackendRunResources(o.args);
    expect(o.stopMcpServer).toHaveBeenCalledTimes(1);
    expect(o.cancel).toHaveBeenCalledTimes(1);
    expect(o.unmountUi).toHaveBeenCalledTimes(1);
  });

  it('still releases the local UI when the runtime reset fails, and propagates the failure', async () => {
    // A runtime that cannot prove its backend stopped now rejects. That failure
    // must reach the caller so no success is published, but it must not strand
    // the terminal display mounted: local teardown owns resources the failed
    // runtime knows nothing about.
    const failure = new Error('[copilot] reset failed (unverified-termination)');
    const o = opts(async () => {
      throw failure;
    });
    await expect(cleanupBackendRunResources(o.args)).rejects.toBe(failure);
    expect(o.unmountUi).toHaveBeenCalledTimes(1);
  });
});
