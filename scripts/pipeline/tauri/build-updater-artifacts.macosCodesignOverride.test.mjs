import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMacosCodesignWrapper,
  resolveMacosCodesignOverrideConfig,
} from './build-updater-artifacts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('macOS codesign override keeps Bun JIT entitlements off the main Desktop executable', () => {
  const signingIdentity = 'Developer ID Application: Example (TEAMID1234)';
  const config = resolveMacosCodesignOverrideConfig({ signingIdentity });

  assert.deepEqual(Object.keys(config), ['bundle']);
  const macOS = config.bundle.macOS;
  assert.equal(macOS.signingIdentity, signingIdentity);
  assert.equal(macOS.hardenedRuntime, true);

  assert.equal(macOS.entitlements, undefined);
});

test('Desktop bundle still ships hsetup as an external binary covered by executable signing', () => {
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  assert.ok(
    tauriConfig.bundle.externalBin.includes('binaries/hsetup'),
    'hsetup must remain an externalBin so Tauri signs it as an executable with entitlements',
  );
});

test('macOS codesign wrapper adds Bun JIT entitlements only when signing hsetup', () => {
  const tempDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'happier-codesign-wrapper-'));
  const callsPath = path.join(tempDir, 'calls.jsonl');
  const fakeCodesignPath = path.join(tempDir, 'real-codesign');
  fs.writeFileSync(
    fakeCodesignPath,
    `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HAPPIER_CODESIGN_CALLS_PATH\"\n`,
    { mode: 0o755 },
  );
  const wrapperPath = createMacosCodesignWrapper({ dir: tempDir });
  const entitlementsPath = path.join(repoRoot, 'scripts', 'pipeline', 'release', 'bun-standalone.entitlements.plist');
  const env = {
    ...process.env,
    HAPPIER_REAL_CODESIGN_PATH: fakeCodesignPath,
    HAPPIER_BUN_ENTITLEMENTS_PATH: entitlementsPath,
    HAPPIER_CODESIGN_CALLS_PATH: callsPath,
  };

  try {
    execFileSync(wrapperPath, ['--force', '-s', '-', '--options', 'runtime', '/tmp/Happier.app/Contents/MacOS/hsetup'], { env });
    execFileSync(wrapperPath, ['--force', '-s', '-', '--options', 'runtime', '/tmp/Happier.app/Contents/MacOS/app'], { env });

    const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n');
    assert.match(calls[0], new RegExp(`--entitlements ${entitlementsPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
    assert.doesNotMatch(calls[1], /--entitlements/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
