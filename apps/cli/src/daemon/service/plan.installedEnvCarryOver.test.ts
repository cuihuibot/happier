import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { doesInstalledDaemonServiceDefinitionMatchExpected } from './doesInstalledDaemonServiceDefinitionMatchExpected';
import { planDaemonServiceInstall, type DaemonServicePlatform } from './plan';

const OPERATOR_PATH = '/Users/operator/.happier/bin:/operator/pinned/path:/usr/bin:/bin';

function makeHomeDir(): string {
  return mkdtempSync(join(tmpdir(), 'happier-service-carryover-'));
}

function planFor(params: Readonly<{
  platform: DaemonServicePlatform;
  userHomeDir: string;
  entryPath?: string;
}>) {
  return planDaemonServiceInstall({
    platform: params.platform,
    mode: 'user',
    channel: 'stable',
    targetMode: 'pinned',
    instanceId: 'default',
    activeServerId: 'cloud',
    userHomeDir: params.userHomeDir,
    happierHomeDir: join(params.userHomeDir, '.happier'),
    serverUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    nodePath: join(params.userHomeDir, '.happier/tools/js-runtime/current/bin/node'),
    entryPath: params.entryPath
      ?? join(params.userHomeDir, '.happier/cli/versions/0.2.12-a/package-dist/index.mjs'),
    copilotSdkExperiment: null,
  });
}

function writeInstalled(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function withDarwinEnvEntry(plist: string, key: string, value: string): string {
  return plist.replace(
    '<key>HAPPIER_HOME_DIR</key>',
    `<key>${key}</key>\n      <string>${value}</string>\n      <key>HAPPIER_HOME_DIR</key>`,
  );
}

function withDarwinPath(plist: string, value: string): string {
  return plist.replace(/(<key>PATH<\/key>\s*<string>)[\s\S]*?(<\/string>)/, `$1${value}$2`);
}

describe('daemon service regeneration preserves the installed operator environment', () => {
  it('carries an allowlisted update-check override and the installed PATH across darwin regeneration', () => {
    const home = makeHomeDir();
    const first = planFor({ platform: 'darwin', userHomeDir: home });
    const installedPath = first.files[0]!.path;
    const installed = withDarwinPath(
      withDarwinEnvEntry(first.files[0]!.content, 'HAPPIER_CLI_UPDATE_CHECK', '0'),
      OPERATOR_PATH,
    );
    writeInstalled(installedPath, installed);

    const regenerated = planFor({ platform: 'darwin', userHomeDir: home }).files[0]!.content;

    expect(regenerated).toContain('<key>HAPPIER_CLI_UPDATE_CHECK</key>');
    expect(regenerated).toContain('<string>0</string>');
    expect(regenerated).toContain(OPERATOR_PATH);
  });

  it('leaves ordinary installs on update-check defaults when no definition is installed', () => {
    const home = makeHomeDir();
    const content = planFor({ platform: 'darwin', userHomeDir: home }).files[0]!.content;

    expect(content).not.toContain('HAPPIER_CLI_UPDATE_CHECK');
    expect(content).not.toContain('/operator/pinned/path');
  });

  it('does not carry arbitrary non-allowlisted environment keys across regeneration', () => {
    const home = makeHomeDir();
    const first = planFor({ platform: 'darwin', userHomeDir: home });
    writeInstalled(
      first.files[0]!.path,
      withDarwinEnvEntry(first.files[0]!.content, 'HAPPIER_OPERATOR_SECRET', 'leaked'),
    );

    const regenerated = planFor({ platform: 'darwin', userHomeDir: home }).files[0]!.content;

    expect(regenerated).not.toContain('HAPPIER_OPERATOR_SECRET');
  });

  it('ignores an unsupported update-check override value', () => {
    const home = makeHomeDir();
    const first = planFor({ platform: 'darwin', userHomeDir: home });
    writeInstalled(
      first.files[0]!.path,
      withDarwinEnvEntry(first.files[0]!.content, 'HAPPIER_CLI_UPDATE_CHECK', 'maybe'),
    );

    const regenerated = planFor({ platform: 'darwin', userHomeDir: home }).files[0]!.content;

    expect(regenerated).not.toContain('HAPPIER_CLI_UPDATE_CHECK');
  });

  it('carries the allowlisted override across linux systemd regeneration', () => {
    const home = makeHomeDir();
    const first = planFor({ platform: 'linux', userHomeDir: home });
    writeInstalled(
      first.files[0]!.path,
      `${first.files[0]!.content}\nEnvironment=HAPPIER_CLI_UPDATE_CHECK=0\n`,
    );

    const regenerated = planFor({ platform: 'linux', userHomeDir: home }).files[0]!.content;

    expect(regenerated).toContain('Environment=HAPPIER_CLI_UPDATE_CHECK=0');
  });

  it('carries the allowlisted override across windows wrapper regeneration', () => {
    const home = makeHomeDir();
    const first = planFor({ platform: 'win32', userHomeDir: home });
    writeInstalled(
      first.files[0]!.path,
      first.files[0]!.content.replace(
        '$env:HAPPIER_HOME_DIR',
        '$env:HAPPIER_CLI_UPDATE_CHECK = "0"\n  $env:HAPPIER_HOME_DIR',
      ),
    );

    const regenerated = planFor({ platform: 'win32', userHomeDir: home }).files[0]!.content;

    expect(regenerated).toContain('$env:HAPPIER_CLI_UPDATE_CHECK = "0"');
  });
});

describe('daemon service drift detection owns the pinned daemon entry', () => {
  it('reports drift when the installed definition pins a different CLI entry', () => {
    const home = makeHomeDir();
    const installedPath = join(home, 'old.plist');
    writeInstalled(
      installedPath,
      planFor({
        platform: 'darwin',
        userHomeDir: home,
        entryPath: join(home, '.happier/cli/versions/0.2.11-old/package-dist/index.mjs'),
      }).files[0]!.content,
    );

    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath,
      expectedContents: planFor({
        platform: 'darwin',
        userHomeDir: home,
        entryPath: join(home, '.happier/cli/versions/0.2.12-new/package-dist/index.mjs'),
      }).files[0]!.content,
    })).toBe(false);
  });

  it('reports no drift when the installed definition pins the same CLI entry', () => {
    const home = makeHomeDir();
    const installedPath = join(home, 'same.plist');
    const content = planFor({ platform: 'darwin', userHomeDir: home }).files[0]!.content;
    writeInstalled(installedPath, content);

    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath,
      expectedContents: content,
    })).toBe(true);
  });

  it('refreshes a promoted entry while preserving the operator update-check override', () => {
    const home = makeHomeDir();
    const oldEntry = join(home, '.happier/cli/versions/0.2.11-old/package-dist/index.mjs');
    const newEntry = join(home, '.happier/cli/versions/0.2.12-new/package-dist/index.mjs');
    const first = planFor({ platform: 'darwin', userHomeDir: home, entryPath: oldEntry });
    const installedPath = first.files[0]!.path;
    writeInstalled(
      installedPath,
      withDarwinEnvEntry(first.files[0]!.content, 'HAPPIER_CLI_UPDATE_CHECK', '0'),
    );

    const expected = planFor({ platform: 'darwin', userHomeDir: home, entryPath: newEntry }).files[0]!.content;

    expect(doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath,
      expectedContents: expected,
    })).toBe(false);
    expect(expected).toContain(newEntry);
    expect(expected).toContain('<key>HAPPIER_CLI_UPDATE_CHECK</key>');
  });
});
