import { describe, expect, it } from 'vitest';

import {
  CopilotSdkExperimentSettingsError,
  buildCopilotSdkExperimentServiceEnv,
  parseCopilotSdkExperimentOptIn,
  readCopilotSdkExperimentSettings,
} from './copilotSdkExperimentSettings';

describe('copilot SDK experiment settings', () => {
  it('is disabled when settings carry no opt-in', () => {
    expect(readCopilotSdkExperimentSettings({})).toBeNull();
  });

  it('generates no service environment when the opt-in is absent', () => {
    expect(buildCopilotSdkExperimentServiceEnv(null)).toEqual({});
  });

  it('reads a configured opt-in with its mandatory native CLI path', () => {
    const value = readCopilotSdkExperimentSettings({
      copilotSdkExperiment: { enabled: true, cliPath: '/usr/local/bin/copilot' },
    });
    expect(value).toEqual({ enabled: true, cliPath: '/usr/local/bin/copilot' });
  });

  it('emits both allowlisted keys together so a selected SDK runtime can bind its CLI', () => {
    const env = buildCopilotSdkExperimentServiceEnv({ enabled: true, cliPath: '/usr/local/bin/copilot' });
    expect(env).toEqual({
      HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
      HAPPIER_COPILOT_SDK_CLI_PATH: '/usr/local/bin/copilot',
    });
  });

  it('treats an explicitly disabled opt-in as off and emits no keys', () => {
    const value = readCopilotSdkExperimentSettings({
      copilotSdkExperiment: { enabled: false, cliPath: '/usr/local/bin/copilot' },
    });
    expect(value).toBeNull();
    expect(buildCopilotSdkExperimentServiceEnv(value)).toEqual({});
  });

  it('fails loudly when a persisted opt-in is enabled without a native CLI path', () => {
    expect(() => readCopilotSdkExperimentSettings({
      copilotSdkExperiment: { enabled: true },
    })).toThrow(CopilotSdkExperimentSettingsError);
  });

  it('rejects a relative native CLI path instead of accepting an unusable opt-in', () => {
    expect(() => parseCopilotSdkExperimentOptIn({ cliPath: './copilot' })).toThrow(CopilotSdkExperimentSettingsError);
  });

  it('rejects an empty native CLI path at the operator write boundary', () => {
    expect(() => parseCopilotSdkExperimentOptIn({ cliPath: '   ' })).toThrow(CopilotSdkExperimentSettingsError);
  });

  it('accepts a validated operator opt-in', () => {
    expect(parseCopilotSdkExperimentOptIn({ cliPath: '/opt/copilot/bin/copilot' })).toEqual({
      enabled: true,
      cliPath: '/opt/copilot/bin/copilot',
    });
  });

  it('never forwards a non-allowlisted persisted key into the service environment', () => {
    const value = readCopilotSdkExperimentSettings({
      copilotSdkExperiment: {
        enabled: true,
        cliPath: '/usr/local/bin/copilot',
        HAPPIER_SECRET_TOKEN: 'must-not-propagate',
      },
    });
    const env = buildCopilotSdkExperimentServiceEnv(value);
    expect(Object.keys(env).sort()).toEqual(['HAPPIER_COPILOT_SDK_CLI_PATH', 'HAPPIER_COPILOT_SDK_EXPERIMENT']);
  });
});
