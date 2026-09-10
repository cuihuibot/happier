/**
 * Copilot runtime selection seam.
 *
 * Single decision point for which runtime backs a Copilot session. ACP remains
 * the default and the only runtime for sessions that already exist; the
 * experimental SDK runtime is reachable exclusively for a brand-new owned
 * session under an explicit opt-in. There is deliberately no fallback path:
 * a selected SDK runtime that cannot start surfaces its error instead of
 * silently degrading to ACP.
 */
import { createCopilotAcpRuntime } from '@/backends/copilot/acp/runtime';
import { createCopilotSdkRuntime } from '@/backends/copilot/sdk/runtime';
import { resolveMaxAiCredits } from '@/backends/copilot/sdk/backend';
import { readCopilotBackendAffinity } from '@/backends/copilot/sdk/backendAffinity';
import {
  assertNoSilentRuntimeFallback,
  resolveCopilotRuntimeKind,
  type CopilotRuntimeKind,
} from '@/backends/copilot/sdk/runtimeSelection';
import { logger } from '@/ui/logger';

import type { SessionLaunchOrigin } from '@/api/types';

type CopilotRuntimeFactoryParams = Parameters<typeof createCopilotAcpRuntime>[0] & {
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Authoritative create-or-load origin supplied by the common session
   * initializer. Absent is equivalent to `'unknown'` and never opts in.
   */
  sessionLaunchOrigin?: SessionLaunchOrigin;
};

export function createCopilotRuntime(
  params: CopilotRuntimeFactoryParams,
): ReturnType<typeof createCopilotAcpRuntime> & { runtimeKind: CopilotRuntimeKind } {
  // Backend transport affinity is recorded durably and separately from the
  // native vendor session id: `copilotSessionId` is written by BOTH runtimes,
  // so it identifies the vendor session, never the transport.
  const metadata = params.session.getMetadataSnapshot();
  const existingBackendAffinity = readCopilotBackendAffinity(metadata);

  const selected = resolveCopilotRuntimeKind(params.processEnv ?? process.env, {
    existingBackendAffinity,
    sessionLaunchOrigin: params.sessionLaunchOrigin ?? 'unknown',
    // An unhonored opt-in must be visible by default: otherwise an operator who
    // asked for the SDK cannot tell that the run silently stayed on ACP.
    onDiagnostic: (message) => logger.info(`[copilot] ${message}`),
  });

  // Selection must be observable by default: a session that silently ran the
  // wrong runtime is otherwise indistinguishable in the logs.
  logger.info(
    `[copilot] runtime selection resolved kind=${selected} affinity=${existingBackendAffinity ?? 'none'} origin=${params.sessionLaunchOrigin ?? 'unknown'}`,
  );

  if (selected === 'sdk') {
    const env = params.processEnv ?? process.env;
    const runtime = createCopilotSdkRuntime({
      directory: params.directory,
      session: params.session,
      messageBuffer: params.messageBuffer,
      mcpServers: params.mcpServers,
      permissionHandler: params.permissionHandler,
      onThinkingChange: params.onThinkingChange,
      providerInputConsumer: params.providerInputConsumer,
      sessionLaunchOrigin: params.sessionLaunchOrigin ?? 'unknown',
      cliPath: resolveCopilotCliPath(env),
      ...(env.HAPPIER_COPILOT_SDK_MODEL ? { model: env.HAPPIER_COPILOT_SDK_MODEL } : {}),
      ...(env.HAPPIER_COPILOT_SDK_CONFIG_DIR
        ? { configDirectory: env.HAPPIER_COPILOT_SDK_CONFIG_DIR }
        : {}),
      ...(() => {
        const credits = parseStrictPositiveInteger(
          env.HAPPIER_COPILOT_SDK_MAX_CREDITS,
          'HAPPIER_COPILOT_SDK_MAX_CREDITS',
        );
        return credits === undefined ? {} : { maxAiCredits: resolveMaxAiCredits(credits) };
      })(),
      // Soft observational stop for bounded spike runs. Post-request accounting
      // only: it cannot prevent an in-flight call, bound concurrency or cap
      // currency, and the native credit threshold cannot serve this role either.
      ...(() => {
        const ceiling = parseStrictPositiveInteger(
          env.HAPPIER_COPILOT_SDK_MAX_MODEL_CALLS,
          'HAPPIER_COPILOT_SDK_MAX_MODEL_CALLS',
        );
        return ceiling === undefined ? {} : { modelCallCeiling: ceiling };
      })(),
      // Durable sanitized accounting for bounded live runs. Default-off and
      // bound to an explicit fixture path; an external driver cannot read
      // in-process counters after the owned runtime terminates.
      ...(env.HAPPIER_COPILOT_SDK_USAGE_SINK
        ? { usageSinkPath: env.HAPPIER_COPILOT_SDK_USAGE_SINK }
        : {}),
      // The host-resolved per-session environment must reach the native runtime
      // process; otherwise it inherits ambient env and runs native file hooks
      // against the wrong Happier session.
      ...(params.processEnv ? { processEnv: params.processEnv } : {}),
      ...(params.pendingQueueDrainMaxPopPerWake !== undefined
        ? { pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake }
        : {}),
    });
    assertNoSilentRuntimeFallback({ selected, actual: 'sdk' });
    return Object.assign(runtime, { runtimeKind: 'sdk' as const });
  }

  const runtime = createCopilotAcpRuntime(params);
  assertNoSilentRuntimeFallback({ selected, actual: 'acp' });
  return Object.assign(runtime, { runtimeKind: 'acp' as const });
}

function resolveCopilotCliPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.HAPPIER_COPILOT_SDK_CLI_PATH;
  if (!explicit) {
    throw new Error(
      'Copilot SDK runtime requires HAPPIER_COPILOT_SDK_CLI_PATH to bind the installed Copilot CLI',
    );
  }
  return explicit;
}

/**
 * Parses a configured integer flag strictly.
 *
 * `Number.parseInt` accepts a prefix ("30abc" -> 30) and would silently install
 * a threshold the operator never configured, so the raw text must be an exact
 * positive integer within the safe range before any consumer sees it.
 */
function parseStrictPositiveInteger(raw: string | undefined, varName: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Copilot SDK runtime: ${varName} must be a positive integer, received "${raw}"`,
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Copilot SDK runtime: ${varName} must be a positive integer, received "${raw}"`,
    );
  }
  return value;
}
