import fs from 'node:fs';

import {
  decodeServicePlistString,
  extractLaunchdPlistEnv,
} from './installedServiceEnvCarryOver';

/**
 * Semantic equivalence check for darwin launchd plist service definitions.
 *
 * Background: the previous raw-file-equality check (`installed.trim() ===
 * expected.trim()`) reported spurious drift because the expected content is
 * regenerated on every invocation using the caller's `process.env.PATH`,
 * which includes ephemeral segments like `fnm_multishells/<pid>_<ts>/bin`
 * and cwd-derived `node_modules/.bin`. It also kept flagging drift when the
 * installed plist used the `[node, entry, daemon, start-sync]` ProgramArguments
 * form while the current plan-builder produces the semantically-equivalent
 * `[shim, daemon, start-sync]` form.
 *
 * This comparator extracts only the fields that materially determine runtime
 * behavior and compares those. It intentionally ignores `PATH`, which the
 * planner now carries over from the installed definition instead of
 * regenerating from the invoking shell.
 *
 * `ProgramArguments` is compared exactly: it pins which CLI build the daemon
 * runs. Treating a differing launcher or entry path as equivalent made
 * promotion silent — `happier service restart` saw no drift and rebooted the
 * previously pinned build. Exact comparison makes the supported restart
 * refresh the pinned definition to the CLI performing it.
 *
 * Returns true when both definitions would launch the same daemon build under
 * the same Happier home, channel, and target mode — i.e. no meaningful drift.
 */
export function doesInstalledDaemonServiceDefinitionMatchExpected(params: Readonly<{
  installedPath: string;
  expectedContents: string;
}>): boolean {
  let installedRaw: string;
  try {
    installedRaw = fs.readFileSync(params.installedPath, 'utf-8');
  } catch {
    return false;
  }

  // Fast-path: exact byte-equal (post-trim). Cheap win for freshly-installed
  // services where nothing has drifted yet.
  if (installedRaw.trim() === params.expectedContents.trim()) return true;

  const installed = extractPlistSignature(installedRaw);
  const expected = extractPlistSignature(params.expectedContents);
  if (!installed || !expected) return false;
  return compareServiceSignatures(installed, expected);
}

// ─────────────────────────────────────────────────────────────────────────
// Extracted signature comparison
// ─────────────────────────────────────────────────────────────────────────

type PlistSignature = Readonly<{
  label: string;
  programArguments: readonly string[];
  env: Readonly<Record<string, string>>;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}>;

function compareServiceSignatures(a: PlistSignature, b: PlistSignature): boolean {
  if (a.label !== b.label) return false;
  if (a.workingDirectory !== b.workingDirectory) return false;
  if (a.stdoutPath !== b.stdoutPath) return false;
  if (a.stderrPath !== b.stderrPath) return false;
  if (!equalStringLists(a.programArguments, b.programArguments)) return false;
  // Drop PATH from both sides — the installed value is authoritative and is
  // carried over by the planner rather than regenerated per invocation.
  const aEnv = stripNoiseEnvKeys(a.env);
  const bEnv = stripNoiseEnvKeys(b.env);
  return shallowEqualStringMap(aEnv, bEnv);
}

const NOISE_ENV_KEYS = new Set(['PATH']);

function stripNoiseEnvKeys(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (NOISE_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function shallowEqualStringMap(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function equalStringLists(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Plist extraction (regex-based — the plist template is ours; narrowly scoped)
// ─────────────────────────────────────────────────────────────────────────

function extractPlistSignature(plistXml: string): PlistSignature | null {
  const label = extractPlistStringValue(plistXml, 'Label');
  if (!label) return null;
  const programArguments = extractPlistArrayStrings(plistXml, 'ProgramArguments');
  if (programArguments.length === 0) return null;
  return {
    label,
    programArguments,
    env: extractLaunchdPlistEnv(plistXml),
    workingDirectory: extractPlistStringValue(plistXml, 'WorkingDirectory') ?? '',
    stdoutPath: extractPlistStringValue(plistXml, 'StandardOutPath') ?? '',
    stderrPath: extractPlistStringValue(plistXml, 'StandardErrorPath') ?? '',
  };
}

function extractPlistStringValue(plistXml: string, key: string): string | null {
  const pattern = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<string>([\\s\\S]*?)</string>`);
  const match = plistXml.match(pattern);
  return match ? decodeServicePlistString(match[1]) : null;
}

function extractPlistArrayStrings(plistXml: string, key: string): readonly string[] {
  const pattern = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<array>([\\s\\S]*?)</array>`);
  const match = plistXml.match(pattern);
  if (!match) return [];
  const arrayBody = match[1];
  const strings: string[] = [];
  const stringPattern = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = stringPattern.exec(arrayBody)) !== null) {
    strings.push(decodeServicePlistString(m[1]));
  }
  return strings;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
