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
/**
 * Resolved flight state.
 *
 * `newSessionOptIn` and the native path are deliberately separate concerns:
 * turning the flight off is a *new-session* opt-out, not a de-configuration of
 * the native runtime. `runtimeSelection.ts` keeps an already SDK-bound session
 * on the SDK transport even when the opt-in flag is absent, and
 * `runtimeFactory.ts` then throws unless the CLI path is still supplied, so the
 * validated path must survive a disable or every previously created SDK session
 * becomes unopenable after a service refresh.
 */
export type CopilotSdkExperimentSettings = Readonly<{
  newSessionOptIn: boolean;
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
  return { newSessionOptIn: true, cliPath: normalizeCliPath(input.cliPath) };
}

/**
 * Produces the record to persist when an operator turns the flight off.
 *
 * The validated native path is retained so existing SDK-bound sessions can
 * still be reopened; only the new-session opt-in is cleared. A home that never
 * configured a flight stays unconfigured (`undefined`) so its generated service
 * definition remains byte-identical to the default-off template.
 */
export function disableCopilotSdkExperimentOptIn(
  settings: Readonly<{ copilotSdkExperiment?: unknown }>,
): CopilotSdkExperimentSettings | undefined {
  const current = readCopilotSdkExperimentSettings(settings);
  if (!current) return undefined;
  return { newSessionOptIn: false, cliPath: current.cliPath };
}

/**
 * Serializes the resolved state into its persisted record shape.
 *
 * The on-disk key stays `enabled` while the in-memory field is
 * `newSessionOptIn`, so this conversion is explicit rather than an accidental
 * structural match.
 */
export function toPersistedCopilotSdkExperiment(
  value: CopilotSdkExperimentSettings | undefined,
): Readonly<{ enabled: boolean; cliPath: string }> | undefined {
  if (!value) return undefined;
  return { enabled: value.newSessionOptIn, cliPath: value.cliPath };
}

/**
 * Reads the persisted flight.
 *
 * Returns `null` only when no flight was ever configured. A configured but
 * disabled flight is returned with `newSessionOptIn: false` and its retained
 * path, because "opted out of new SDK sessions" is not the same state as "no
 * native runtime configured". A configured record whose path is unusable throws,
 * so a tampered record cannot degrade into a silently disabled flight.
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
  if (typeof record.enabled !== 'boolean') {
    throw new CopilotSdkExperimentSettingsError(
      'Persisted Copilot SDK experiment settings are malformed: "enabled" must be a boolean.',
    );
  }
  return { newSessionOptIn: record.enabled, cliPath: normalizeCliPath(record.cliPath) };
}

/**
 * Builds the allowlisted daemon service environment contribution.
 *
 * - never configured -> no keys at all, byte-identical to the default template
 * - configured, opted in -> opt-in flag plus the native path
 * - configured, opted out -> the native path only, so new sessions fall back to
 *   ACP while an existing SDK-bound session can still bind its runtime
 */
export function buildCopilotSdkExperimentServiceEnv(
  value: CopilotSdkExperimentSettings | null,
): Record<string, string> {
  if (!value) return {};
  return {
    ...(value.newSessionOptIn ? { [COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY]: '1' } : {}),
    [COPILOT_SDK_EXPERIMENT_CLI_PATH_ENV_KEY]: value.cliPath,
  };
}
