import fs from 'node:fs';

import type { DaemonServicePlatform } from './plan';

/**
 * Environment keys an operator may set directly on an installed daemon service
 * definition and that regeneration must not silently erase.
 *
 * The daemon service definition is rewritten from the current template on
 * every install and on the start/restart drift refresh. Anything the template
 * does not derive is lost on that rewrite, which silently removed a
 * deliberately installed `HAPPIER_CLI_UPDATE_CHECK=0` update guard from a
 * pinned canary service.
 *
 * This is an explicit allowlist with validated values, not general environment
 * preservation: an unknown key, or a value outside the supported set, is
 * dropped so drift detection, security posture, and update defaults for
 * ordinary installs are unchanged.
 */
const OPERATOR_ENV_OVERRIDE_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['HAPPIER_CLI_UPDATE_CHECK', new Set(['0', '1'])],
]);

export type InstalledDaemonServiceEnvCarryOver = Readonly<{
  /**
   * `PATH` exactly as the installed definition carries it, or `null` when no
   * definition is installed. The template derives `PATH` from the environment
   * of whichever shell ran the command, so regenerating it would silently
   * rewrite the daemon's search path on an unrelated restart.
   */
  path: string | null;
  operatorOverrides: Readonly<Record<string, string>>;
}>;

export const NO_INSTALLED_DAEMON_SERVICE_ENV_CARRY_OVER: InstalledDaemonServiceEnvCarryOver = {
  path: null,
  operatorOverrides: {},
};

export function readInstalledDaemonServiceEnvCarryOver(params: Readonly<{
  platform: DaemonServicePlatform;
  installedDefinitionPath: string;
}>): InstalledDaemonServiceEnvCarryOver {
  let contents: string;
  try {
    contents = fs.readFileSync(params.installedDefinitionPath, 'utf-8');
  } catch {
    return NO_INSTALLED_DAEMON_SERVICE_ENV_CARRY_OVER;
  }
  return resolveInstalledDaemonServiceEnvCarryOver({ platform: params.platform, contents });
}

export function resolveInstalledDaemonServiceEnvCarryOver(params: Readonly<{
  platform: DaemonServicePlatform;
  contents: string;
}>): InstalledDaemonServiceEnvCarryOver {
  const env = parseInstalledDaemonServiceEnv(params);
  const pathKey = params.platform === 'win32'
    ? Object.keys(env).find((key) => key.toLowerCase() === 'path')
    : 'PATH';
  const pathValue = pathKey ? String(env[pathKey] ?? '').trim() : '';

  const operatorOverrides: Record<string, string> = {};
  for (const [key, supportedValues] of OPERATOR_ENV_OVERRIDE_ALLOWLIST) {
    const value = String(env[key] ?? '').trim();
    if (supportedValues.has(value)) {
      operatorOverrides[key] = value;
    }
  }

  return { path: pathValue || null, operatorOverrides };
}

export function parseInstalledDaemonServiceEnv(params: Readonly<{
  platform: DaemonServicePlatform;
  contents: string;
}>): Readonly<Record<string, string>> {
  if (params.platform === 'darwin') return extractLaunchdPlistEnv(params.contents);
  if (params.platform === 'win32') return extractWindowsWrapperEnv(params.contents);
  return extractSystemdUnitEnv(params.contents);
}

/**
 * Minimal XML entity decoding. Happier service plists only ever emit
 * `&amp; &lt; &gt;` because values are paths, ids, and environment values.
 */
export function decodeServicePlistString(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

export function extractLaunchdPlistEnv(plistXml: string): Readonly<Record<string, string>> {
  const match = plistXml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!match) return {};
  const out: Record<string, string> = {};
  // Pairs are <key>K</key><string>V</string>. `<true/>`/`<false/>` are accepted
  // and stringified so an unexpected value type cannot throw.
  const pairPattern = /<key>([\s\S]*?)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<(true|false)\s*\/>)/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairPattern.exec(match[1])) !== null) {
    const key = decodeServicePlistString(pair[1]);
    out[key] = pair[2] !== undefined ? decodeServicePlistString(pair[2]) : (pair[3] ?? '');
  }
  return out;
}

function extractSystemdUnitEnv(unit: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of unit.split(/\r?\n/)) {
    const match = line.match(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
    if (!match) continue;
    out[match[1]] = decodeSystemdEnvValue(match[2]);
  }
  return out;
}

function decodeSystemdEnvValue(raw: string): string {
  const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
  const body = quoted ? raw.slice(1, -1) : raw;
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/%%/g, '%');
}

function extractWindowsWrapperEnv(wrapper: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of wrapper.split(/\r?\n/)) {
    const match = line.match(/^\s*\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([\s\S]*)"\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/`"/g, '"').replace(/``/g, '`');
  }
  return out;
}
