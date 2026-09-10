import { stopCaffeinate } from '@/integrations/caffeinate';

export async function cleanupBackendRunResources(opts: {
  keepAliveInterval: ReturnType<typeof setInterval>;
  reconnectionHandle?: { cancel: () => void } | null;
  stopMcpServer: () => void;
  resetRuntime: () => Promise<void>;
  unmountUi: () => void;
}): Promise<void> {
  clearInterval(opts.keepAliveInterval);
  opts.reconnectionHandle?.cancel();
  stopCaffeinate();
  opts.stopMcpServer();
  try {
    await opts.resetRuntime();
  } finally {
    // The runtime now rejects when it cannot prove its backend stopped. That
    // failure must still reach the caller so nothing publishes success, but the
    // local display is not the failed runtime's to hold: unmounting here keeps
    // an unresolved backend teardown from stranding the terminal UI mounted.
    opts.unmountUi();
  }
}
