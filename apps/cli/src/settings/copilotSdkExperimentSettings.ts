import { isAbsolute } from 'node:path';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

/**
 * Canonical owner for the persisted, experimental Copilot SDK flight.
 *
 * The runtime selector (`backends/copilot/sdk/runtimeSelection.ts`) reads
 * `HAPPIER_COPILOT_SDK_EXPERIMENT` from the environment, and
 * `backends/copilot/runtimeFactory.ts` requires `HAPPIER_COPILOT_SDK_CLI_PATH`
 * once the SDK runtime is selected. Persisting the opt-in here lets the daemon
 * service definition be generated from settings, so the installer, the
 * expected-definition comparison and the start/restart drift refresh all agree
 * instead of silently erasing a hand-edited service environment.
 *
 * Only these two keys are ever produced; this is an explicit allowlist, not a
 * general environment-forwarding mechanism.
 */
export type CopilotSdkExperimentSettings = Readonly<{
  enabled: true;
  cliPath: string;
}>;

export const COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY = 'HAPPIER_COPILOT_SDK_EXPERIMENT';
export const COPILOT_SDK_EXPERIMENT_CLI_PATH_ENV_KEY = 'HAPPIER_COPILOT_SDK_CLI_PATH';

export class CopilotSdkExperimentSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotSdkExperimentSettingsError';
  }
}

function normalizeCliPath(rawCliPath: unknown): string {
  if (typeof rawCliPath !== 'string' || !rawCliPath.trim()) {
    throw new CopilotSdkExperimentSettingsError(
      'Copilot SDK experiment requires a native Copilot CLI path; an enabled flight without one cannot start a session.',
    );
  }
  const expanded = expandHomeDirPath(rawCliPath.trim());
  if (!isAbsolute(expanded)) {
    throw new CopilotSdkExperimentSettingsError(
      `Copilot SDK experiment requires an absolute native Copilot CLI path; received "${rawCliPath.trim()}".`,
    );
  }
  return expanded;
}

/**
 * Validates an operator-supplied opt-in before it is persisted. Incomplete or
 * unusable input is rejected loudly rather than stored as a flight that would
 * fail at session start.
 */
export function parseCopilotSdkExperimentOptIn(input: Readonly<{ cliPath: unknown }>): CopilotSdkExperimentSettings {
  return { enabled: true, cliPath: normalizeCliPath(input.cliPath) };
}

/**
 * Reads the persisted flight. Returns `null` when no flight is configured or
 * when it is explicitly disabled; throws when a persisted flight is enabled but
 * unusable, so a tampered record cannot degrade into a silently disabled flight.
 */
export function readCopilotSdkExperimentSettings(
  settings: Readonly<{ copilotSdkExperiment?: unknown }>,
): CopilotSdkExperimentSettings | null {
  const raw = settings.copilotSdkExperiment;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CopilotSdkExperimentSettingsError('Persisted Copilot SDK experiment settings are malformed.');
  }
  const record = raw as Record<string, unknown>;
  if (record.enabled !== true) return null;
  return { enabled: true, cliPath: normalizeCliPath(record.cliPath) };
}

/**
 * Builds the allowlisted daemon service environment contribution. An absent
 * flight contributes no keys at all, so the generated definition stays
 * byte-identical to the default-off template.
 */
export function buildCopilotSdkExperimentServiceEnv(
  value: CopilotSdkExperimentSettings | null,
): Record<string, string> {
  if (!value) return {};
  return {
    [COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY]: '1',
    [COPILOT_SDK_EXPERIMENT_CLI_PATH_ENV_KEY]: value.cliPath,
  };
}
