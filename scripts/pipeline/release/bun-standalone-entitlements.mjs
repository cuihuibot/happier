// @ts-check

import { fileURLToPath } from 'node:url';

/**
 * Canonical location of the entitlements granted to Bun-compiled Mach-O binaries.
 *
 * Bun's runtime JIT-allocates executable memory, so a hardened-runtime signature
 * without `com.apple.security.cs.allow-jit` makes the binary abort on startup.
 * Every macOS signing path that seals a Bun standalone binary — the published CLI
 * payloads and the Desktop `hsetup` sidecar — must pass this plist to `codesign`.
 */
export const BUN_STANDALONE_ENTITLEMENTS_PATH = fileURLToPath(
  new URL('./bun-standalone.entitlements.plist', import.meta.url),
);
