/**
 * Root-bounded scratch directories for Copilot SDK spike tests.
 *
 * Spike tests must not write into the shared system temp directory: the spike
 * is confined to its own engineering root, and an earlier test left orphaned
 * directories outside it. This resolves the scratch base from the module's own
 * location rather than `process.cwd()`, so it stays correct regardless of which
 * directory the test runner was started from, and refuses any base that escapes
 * the engineering root.
 *
 * Test support only; not reachable from any product runtime path.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

/** `<engineering-root>/repo/apps/cli/src/backends/copilot/sdk` → engineering root. */
const ENGINEERING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

/** All spike scratch lives under one owned directory inside the engineering root. */
const SCRATCH_ROOT = resolve(ENGINEERING_ROOT, 's2-vertical/workdir/test-scratch');

/**
 * Creates an owned scratch directory and returns it with its exact cleanup.
 *
 * The caller must invoke `cleanup()`; it removes the directory itself, not only
 * the files written into it.
 */
export function createSpikeScratchDir(prefix: string): {
  path: string;
  cleanup: () => void;
} {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const path = createTempDirSync(`${prefix}-`, SCRATCH_ROOT);
  if (!resolve(path).startsWith(SCRATCH_ROOT + sep)) {
    removeTempDirSync(path);
    throw new Error(`spike scratch escaped the engineering root: ${path}`);
  }
  return { path, cleanup: () => removeTempDirSync(path) };
}
