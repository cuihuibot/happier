import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMacosCodesignOverrideConfig } from './build-updater-artifacts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('macOS codesign override signs the hardened Desktop bundle with the Bun JIT entitlements plist', () => {
  const signingIdentity = 'Developer ID Application: Example (TEAMID1234)';
  const config = resolveMacosCodesignOverrideConfig({ signingIdentity });

  assert.deepEqual(Object.keys(config), ['bundle']);
  const macOS = config.bundle.macOS;
  assert.equal(macOS.signingIdentity, signingIdentity);
  assert.equal(macOS.hardenedRuntime, true);

  // Tauri only passes `bundle.macOS.entitlements` to `codesign` (tauri-bundler
  // macos/sign.rs), so a hardened-runtime bundle without it strips Bun's JIT
  // permission from the nested hsetup sidecar and the binary aborts at startup.
  assert.ok(path.isAbsolute(macOS.entitlements), 'entitlements path must be absolute for codesign');
  assert.ok(fs.existsSync(macOS.entitlements), `entitlements plist must exist: ${macOS.entitlements}`);
  assert.equal(
    macOS.entitlements,
    path.join(repoRoot, 'scripts', 'pipeline', 'release', 'bun-standalone.entitlements.plist'),
    'Desktop signing must reuse the shared Bun standalone entitlements plist',
  );
  assert.match(
    fs.readFileSync(macOS.entitlements, 'utf8'),
    /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/u,
  );
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
