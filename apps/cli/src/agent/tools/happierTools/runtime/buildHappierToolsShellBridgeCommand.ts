import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { buildPosixShellCommand, buildPosixShellEnvironmentAssignments } from '@/utils/posixShellCommand';
import {
  haveEqualLiteralShellWords,
  parseHappierToolsShellBridgeCommand,
  type HappierToolsShellBridgeCommand,
} from '@happier-dev/protocol';
import { resolveHappierToolsShellBridgeContextEnv } from './resolveHappierToolsShellBridgeContextEnv';

/**
 * Build the POSIX shell command a shell_bridge provider runs to invoke
 * `happier tools ...`.
 *
 * By default this command stays clean and relies on the provider shell's inherited
 * environment. Set HAPPIER_SHELL_BRIDGE_CONTEXT_ENV=home or full to inline the
 * non-secret Happier runtime context for environments whose shell startup files
 * clobber the inherited Happier home/server selection.
 *
 * `launchSpec.env` (e.g. TSX_TSCONFIG_PATH in dev) is the launch-mechanism env for
 * this specific CLI invocation and is merged after the context.
 */
function buildShellBridgeCommandParts(args: readonly string[]): { command: string; envPrefix: string } {
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools', ...args]);
  const command = buildPosixShellCommand([launchSpec.filePath, ...launchSpec.args]);
  const env = {
    ...resolveHappierToolsShellBridgeContextEnv(),
    ...(launchSpec.env ?? {}),
  };
  return { command, envPrefix: buildPosixShellEnvironmentAssignments(env) };
}

export function buildHappierToolsShellBridgeCommand(args: readonly string[]): string {
  const { command, envPrefix } = buildShellBridgeCommandParts(args);
  return envPrefix ? `${envPrefix} ${command}` : command;
}

function buildCanonicalBridgeArgs(command: HappierToolsShellBridgeCommand): string[] {
  const args: string[] = [command.kind];
  if (command.sessionAgentBridge) args.push('--session-agent-bridge');
  if (command.sessionId) args.push('--session-id', command.sessionId);
  if (command.directory) args.push('--directory', command.directory);
  if (command.kind === 'call') {
    args.push('--source', command.source, '--tool', command.tool);
    if (command.argsJson != null) args.push('--args-json', command.argsJson);
  }
  if (command.json) args.push('--json');
  return args;
}

/**
 * Authorization-grade recognition for the shell bridge.
 *
 * The protocol parser proves that the command is one complete `tools` invocation.
 * This additional equality check constrains the launcher, runtime arguments, and
 * environment prelude to the canonical shape this running CLI would generate,
 * and the invocation itself to the same literal words.
 * Quote-only provider reformatting is allowed; expansions and extra words are not.
 * It does not prove provenance, so callers must still allowlist the parsed operation.
 */
export function parseTrustedHappierToolsShellBridgeCommand(
  command: string,
): HappierToolsShellBridgeCommand | null {
  const parsed = parseHappierToolsShellBridgeCommand(command);
  if (!parsed) return null;
  const { command: expected, envPrefix } = buildShellBridgeCommandParts(buildCanonicalBridgeArgs(parsed));
  if (envPrefix && !parsed.rawCommand.startsWith(`${envPrefix} `)) return null;
  const actual = envPrefix ? parsed.rawCommand.slice(envPrefix.length + 1) : parsed.rawCommand;
  return actual === expected || haveEqualLiteralShellWords(actual, expected) ? parsed : null;
}
