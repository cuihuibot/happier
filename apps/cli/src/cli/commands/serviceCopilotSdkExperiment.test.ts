import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('happier service copilot-sdk-experiment', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
  let tempRootDir: string | undefined;
  let stdout: string;

  beforeEach(async () => {
    tempRootDir = await createTempDir('happier-cli-sdk-flight-');
    applyEnvValues({ HAPPIER_HOME_DIR: join(tempRootDir, 'home') });
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.restoreAllMocks();
    vi.resetModules();
    if (tempRootDir) await removeTempDir(tempRootDir);
    tempRootDir = undefined;
  });

  it('reports the flight as disabled by default', async () => {
    const { handleServiceCopilotSdkExperimentCliCommand } = await import('./serviceCopilotSdkExperiment');
    await handleServiceCopilotSdkExperimentCliCommand({ argv: ['copilot-sdk-experiment', 'status'], commandPath: 'happier service' });
    expect(stdout).toContain('disabled');
  });

  it('persists a validated opt-in and reports it as enabled', async () => {
    const { handleServiceCopilotSdkExperimentCliCommand } = await import('./serviceCopilotSdkExperiment');
    await handleServiceCopilotSdkExperimentCliCommand({
      argv: ['copilot-sdk-experiment', 'enable', '--cli-path', '/usr/local/bin/copilot'],
      commandPath: 'happier service',
    });

    const { readSettings } = await import('@/persistence');
    const { readCopilotSdkExperimentSettings } = await import('@/settings/copilotSdkExperimentSettings');
    expect(readCopilotSdkExperimentSettings(await readSettings())).toEqual({
      enabled: true,
      cliPath: '/usr/local/bin/copilot',
    });
  });

  it('rejects an enable without the mandatory native CLI path and persists nothing', async () => {
    const { handleServiceCopilotSdkExperimentCliCommand } = await import('./serviceCopilotSdkExperiment');
    await expect(handleServiceCopilotSdkExperimentCliCommand({
      argv: ['copilot-sdk-experiment', 'enable'],
      commandPath: 'happier service',
    })).rejects.toThrow();

    const { readSettings } = await import('@/persistence');
    const { readCopilotSdkExperimentSettings } = await import('@/settings/copilotSdkExperimentSettings');
    expect(readCopilotSdkExperimentSettings(await readSettings())).toBeNull();
  });

  it('disables the flight and returns new sessions to the ACP default', async () => {
    const { handleServiceCopilotSdkExperimentCliCommand } = await import('./serviceCopilotSdkExperiment');
    await handleServiceCopilotSdkExperimentCliCommand({
      argv: ['copilot-sdk-experiment', 'enable', '--cli-path', '/usr/local/bin/copilot'],
      commandPath: 'happier service',
    });
    await handleServiceCopilotSdkExperimentCliCommand({ argv: ['copilot-sdk-experiment', 'disable'], commandPath: 'happier service' });

    const { readSettings } = await import('@/persistence');
    const { readCopilotSdkExperimentSettings } = await import('@/settings/copilotSdkExperimentSettings');
    expect(readCopilotSdkExperimentSettings(await readSettings())).toBeNull();
  });

  it('states that the flight is host-wide and needs a service re-apply to take effect', async () => {
    const { handleServiceCopilotSdkExperimentCliCommand } = await import('./serviceCopilotSdkExperiment');
    await handleServiceCopilotSdkExperimentCliCommand({
      argv: ['copilot-sdk-experiment', 'enable', '--cli-path', '/usr/local/bin/copilot'],
      commandPath: 'happier service',
    });
    expect(stdout).toContain('host-wide');
    expect(stdout).toContain('happier service restart');
  });
});
