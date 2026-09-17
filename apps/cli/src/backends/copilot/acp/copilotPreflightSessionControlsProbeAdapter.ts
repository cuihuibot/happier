import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { buildCopilotAcpBackendOptions } from './backend';

export const copilotPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
  connectedServiceAuth: 'materialized-env',
  failureCacheStrategy: 'cooldown',
  probeConfigOptionsRaw: async (params) => {
    const backend = new AcpBackend(buildCopilotAcpBackendOptions({
      cwd: params.cwd,
      env: params.processEnv,
      mcpServers: {},
      permissionMode: 'read-only',
      permissionHandler: { handleToolCall: async () => ({ decision: 'abort' }) },
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        backend.startSession(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Copilot session-controls discovery timed out')), Math.max(250, params.timeoutMs));
        }),
      ]);
      return backend.getSessionConfigOptionsState();
    } finally {
      if (timer) clearTimeout(timer);
      await backend.dispose();
    }
  },
};
