import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { doesInstalledDaemonServiceDefinitionMatchExpected } from './doesInstalledDaemonServiceDefinitionMatchExpected';
import { planDaemonServiceInstall } from './plan';

const SDK_OPT_IN = { enabled: true, cliPath: '/usr/local/bin/copilot' } as const;

function planWith(copilotSdkExperiment: { enabled: true; cliPath: string } | null) {
  return planDaemonServiceInstall({
    platform: 'darwin',
    mode: 'user',
    channel: 'stable',
    targetMode: 'pinned',
    instanceId: 'default',
    activeServerId: 'cloud',
    userHomeDir: '/Users/example',
    happierHomeDir: '/Users/example/.happier',
    serverUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    nodePath: '/Users/example/.happier/bin/happier',
    entryPath: '/Users/example/.happier/cli/current/happier',
    copilotSdkExperiment,
  });
}

describe('daemon service definition carries the persisted Copilot SDK flight', () => {
  it('omits the SDK keys entirely when no flight is persisted', () => {
    const content = planWith(null).files[0]?.content ?? '';
    expect(content).not.toContain('HAPPIER_COPILOT_SDK_EXPERIMENT');
    expect(content).not.toContain('HAPPIER_COPILOT_SDK_CLI_PATH');
  });

  it('generates a byte-identical definition for the default-off case', () => {
    expect(planWith(null).files[0]?.content).toBe(planWith(null).files[0]?.content);
  });

  it('generates both allowlisted keys when the flight is persisted', () => {
    const content = planWith(SDK_OPT_IN).files[0]?.content ?? '';
    expect(content).toContain('HAPPIER_COPILOT_SDK_EXPERIMENT');
    expect(content).toContain('HAPPIER_COPILOT_SDK_CLI_PATH');
    expect(content).toContain('/usr/local/bin/copilot');
  });

  it('reports no drift when the installed definition already carries the persisted flight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-sdk-service-'));
    const installedPath = join(dir, 'installed.plist');
    writeFileSync(installedPath, planWith(SDK_OPT_IN).files[0]?.content ?? '', 'utf-8');

    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath,
      expectedContents: planWith(SDK_OPT_IN).files[0]?.content ?? '',
    })).toBe(true);
  });

  it('detects drift when the installed definition lost the persisted flight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-sdk-service-'));
    const installedPath = join(dir, 'installed.plist');
    writeFileSync(installedPath, planWith(null).files[0]?.content ?? '', 'utf-8');

    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath,
      expectedContents: planWith(SDK_OPT_IN).files[0]?.content ?? '',
    })).toBe(false);
  });

  it('detects drift when an installed definition carries a flight that is no longer persisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-sdk-service-'));
    const installedPath = join(dir, 'installed.plist');
    writeFileSync(installedPath, planWith(SDK_OPT_IN).files[0]?.content ?? '', 'utf-8');

    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath,
      expectedContents: planWith(null).files[0]?.content ?? '',
    })).toBe(false);
  });
});
