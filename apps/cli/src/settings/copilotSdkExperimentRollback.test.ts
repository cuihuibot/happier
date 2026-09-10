import { describe, expect, it } from 'vitest';

import { resolveCopilotRuntimeKind } from '@/backends/copilot/sdk/runtimeSelection';
import {
  COPILOT_SDK_EXPERIMENT_CLI_PATH_ENV_KEY,
  COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY,
  buildCopilotSdkExperimentServiceEnv,
  parseCopilotSdkExperimentOptIn,
  readCopilotSdkExperimentSettings,
  disableCopilotSdkExperimentOptIn,
  toPersistedCopilotSdkExperiment,
} from '@/settings/copilotSdkExperimentSettings';

/**
 * Rollback regression for the experimental Copilot SDK flight.
 *
 * Disabling the flight is a *new-session* opt-out. It must not also
 * de-configure the native runtime, because `resolveCopilotRuntimeKind`
 * deliberately keeps an existing SDK-bound session on the SDK transport even
 * when the opt-in flag is absent, and `runtimeFactory` then throws unless
 * `HAPPIER_COPILOT_SDK_CLI_PATH` is still present. Dropping the path on disable
 * makes every previously created SDK session unopenable after a service
 * refresh, which breaks the resume/rollback contract.
 */
const CLI_PATH = '/opt/copilot/bin/copilot';

/** Mirrors the daemon service environment a spawned session would inherit. */
function serviceEnv(settings: Readonly<{ copilotSdkExperiment?: unknown }>): NodeJS.ProcessEnv {
  return { ...buildCopilotSdkExperimentServiceEnv(readCopilotSdkExperimentSettings(settings)) };
}

describe('copilot sdk experiment rollback preserves existing SDK sessions', () => {
  it('still supplies the saved native CLI path after the flight is disabled', () => {
    const enabled = { copilotSdkExperiment: toPersistedCopilotSdkExperiment(parseCopilotSdkExperimentOptIn({ cliPath: CLI_PATH })) };
    const disabled = { copilotSdkExperiment: toPersistedCopilotSdkExperiment(disableCopilotSdkExperimentOptIn(enabled)) };

    const env = serviceEnv(disabled);

    // New sessions must fall back to ACP: the opt-in flag is gone.
    expect(env[COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY]).toBeUndefined();
    expect(resolveCopilotRuntimeKind(env, { sessionLaunchOrigin: 'created' })).toBe('acp');

    // An already SDK-bound session still selects SDK, and must still be able to
    // bind the native CLI, otherwise reopening it throws.
    expect(resolveCopilotRuntimeKind(env, { existingBackendAffinity: 'sdk' })).toBe('sdk');
    expect(env[COPILOT_SDK_EXPERIMENT_CLI_PATH_ENV_KEY]).toBe(CLI_PATH);
  });

  it('reports the flight as disabled while the retained path is still readable', () => {
    const enabled = { copilotSdkExperiment: toPersistedCopilotSdkExperiment(parseCopilotSdkExperimentOptIn({ cliPath: CLI_PATH })) };
    const state = readCopilotSdkExperimentSettings({
      copilotSdkExperiment: toPersistedCopilotSdkExperiment(disableCopilotSdkExperimentOptIn(enabled)),
    });

    expect(state).not.toBeNull();
    expect(state?.newSessionOptIn).toBe(false);
    expect(state?.cliPath).toBe(CLI_PATH);
  });

  it('keeps a never-configured home byte-identical to the empty default', () => {
    expect(serviceEnv({})).toEqual({});
    // Disabling a flight that was never configured must not invent a record.
    expect(disableCopilotSdkExperimentOptIn({})).toBeUndefined();
    expect(serviceEnv({ copilotSdkExperiment: toPersistedCopilotSdkExperiment(disableCopilotSdkExperimentOptIn({})) })).toEqual({});
  });

  it('re-enabling after a disable restores the opt-in flag', () => {
    const enabled = { copilotSdkExperiment: toPersistedCopilotSdkExperiment(parseCopilotSdkExperimentOptIn({ cliPath: CLI_PATH })) };
    const disabled = { copilotSdkExperiment: toPersistedCopilotSdkExperiment(disableCopilotSdkExperimentOptIn(enabled)) };
    const reEnabled = { copilotSdkExperiment: toPersistedCopilotSdkExperiment(parseCopilotSdkExperimentOptIn({ cliPath: CLI_PATH })) };

    expect(serviceEnv(disabled)[COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY]).toBeUndefined();
    expect(serviceEnv(reEnabled)[COPILOT_SDK_EXPERIMENT_ENABLED_ENV_KEY]).toBe('1');
    expect(resolveCopilotRuntimeKind(serviceEnv(reEnabled), { sessionLaunchOrigin: 'created' })).toBe('sdk');
  });

  it('refuses a disabled record whose retained path is unusable instead of silently dropping it', () => {
    expect(() =>
      readCopilotSdkExperimentSettings({ copilotSdkExperiment: { enabled: false, cliPath: 'relative/copilot' } }),
    ).toThrow(/absolute/i);
    expect(() =>
      readCopilotSdkExperimentSettings({ copilotSdkExperiment: { enabled: false, cliPath: '' } }),
    ).toThrow(/native Copilot CLI path/i);
  });
});
