import { describe, expect, it } from 'vitest';

import { parseHappierToolsShellBridgeCommand } from './happierToolsShellBridge.js';

describe('parseHappierToolsShellBridgeCommand', () => {
  it('parses happier tools list invocations', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        'happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      ),
    ).toEqual({
      kind: 'list',
      rawCommand: 'happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      json: true,
    });
  });

  it('parses node-invoked happier tools list bridge commands', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        `'/Users/leeroy/.nvm/versions/node/v22.14.0/bin/node' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'list' '--session-id' 'sess-1' '--directory' '/tmp/workspace' '--json'`,
      ),
    ).toEqual({
      kind: 'list',
      rawCommand:
        `'/Users/leeroy/.nvm/versions/node/v22.14.0/bin/node' '--no-warnings' '--no-deprecation' '/Users/leeroy/Documents/Development/happier/dev/apps/cli/dist/index.mjs' 'tools' 'list' '--session-id' 'sess-1' '--directory' '/tmp/workspace' '--json'`,
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      json: true,
    });
  });

  it('parses managed js-runtime wrapper invoked happier tools call bridge commands', () => {
    // Packaged installs resolve the CLI subprocess launcher to the managed
    // JavaScript runtime wrapper (`<happy-home>/tools/js-runtime/current/bin/happier-js-runtime`),
    // not to a bare `node`/`bun` executable.
    const command =
      `'/Users/leeroy/.happier/tools/js-runtime/current/bin/happier-js-runtime' '--no-warnings' '--no-deprecation' '/Users/leeroy/.happier/cli/current/package-dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`;

    expect(parseHappierToolsShellBridgeCommand(command)).toEqual({
      kind: 'call',
      rawCommand: command,
      sessionId: null,
      directory: null,
      source: 'happier',
      tool: 'change_title',
      argsJson: '{"title":"Renamed"}',
      args: { title: 'Renamed' },
      json: true,
    });
  });

  it('parses the Windows managed js-runtime wrapper shim', () => {
    const command =
      `'C:\\Users\\leeroy\\.happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.cmd' '--no-warnings' '--no-deprecation' 'C:\\Users\\leeroy\\.happier\\cli\\current\\package-dist\\index.mjs' 'tools' 'list' '--json'`;

    expect(parseHappierToolsShellBridgeCommand(command)).toMatchObject({
      kind: 'list',
      json: true,
    });
  });

  it('parses managed js-runtime wrapper bridge commands from non-stable channel installs', () => {
    // Preview/publicdev installs live under `cli-<suffix>`, not `cli`.
    const command =
      `'/Users/leeroy/.happier/tools/js-runtime/current/bin/happier-js-runtime' '--no-warnings' '--no-deprecation' '/Users/leeroy/.happier/cli-preview/current/package-dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}' '--json'`;

    expect(parseHappierToolsShellBridgeCommand(command)).toMatchObject({
      kind: 'call',
      source: 'happier',
      tool: 'change_title',
      args: { title: 'Renamed' },
    });
  });

  it.each([
    // Arbitrary executables must never become bridge launchers.
    `'/usr/local/bin/happier-launcher' '/Users/leeroy/.happier/cli/current/package-dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title' '--args-json' '{"title":"Renamed"}'`,
    `'/tmp/attacker/sh' '/Users/leeroy/.happier/cli/current/package-dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title'`,
    // Wrapper basename must match exactly, not by prefix/suffix.
    `'/tmp/attacker/happier-js-runtime-evil' '/Users/leeroy/.happier/cli/current/package-dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title'`,
    `'/tmp/attacker/evil-happier-js-runtime' '/Users/leeroy/.happier/cli/current/package-dist/index.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title'`,
    // Wrong entrypoint under a valid wrapper.
    `'/Users/leeroy/.happier/tools/js-runtime/current/bin/happier-js-runtime' '/tmp/attacker/payload.mjs' 'tools' 'call' '--source' 'happier' '--tool' 'change_title'`,
    // Chained execution after a valid wrapper bridge command.
    `'/Users/leeroy/.happier/tools/js-runtime/current/bin/happier-js-runtime' '/Users/leeroy/.happier/cli/current/package-dist/index.mjs' 'tools' 'list' '--json' && touch /tmp/happier-pwn`,
  ])('rejects non-canonical wrapper bridge commands: %s', (command) => {
    expect(parseHappierToolsShellBridgeCommand(command)).toBeNull();
  });

  it('parses happier tools call invocations with JSON args', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        `happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source happier --tool change_title --args-json '{"title":"Renamed"}' --json`,
      ),
    ).toEqual({
      kind: 'call',
      rawCommand:
        `happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source happier --tool change_title --args-json '{"title":"Renamed"}' --json`,
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      source: 'happier',
      tool: 'change_title',
      argsJson: '{"title":"Renamed"}',
      args: { title: 'Renamed' },
      json: true,
    });
  });

  it('rejects unset preludes', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; FOO=bar happier tools call --source playwright --tool open_page --args-json \'{"url":"https://example.com"}\'',
      ),
    ).toBeNull();
  });

  it('parses env preludes when quoted values contain spaces', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        'HAPPIER_SPAWN_HOOK=\'/Applications/Test Hook/hook.js\' NODE_OPTIONS=\'--require /Applications/Test Hook/register.js\' happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      ),
    ).toEqual({
      kind: 'list',
      rawCommand:
        'HAPPIER_SPAWN_HOOK=\'/Applications/Test Hook/hook.js\' NODE_OPTIONS=\'--require /Applications/Test Hook/register.js\' happier tools list --session-id "sess-1" --directory "/tmp/workspace" --json',
      sessionId: 'sess-1',
      directory: '/tmp/workspace',
      json: true,
    });
  });

  it('returns null for unrelated shell commands', () => {
    expect(parseHappierToolsShellBridgeCommand('git status --short')).toBeNull();
  });

  it.each([
    'happier tools call --source happier --tool save_memory --json; touch /tmp/happier-pwn',
    'happier tools call --source happier --tool save_memory --json && touch /tmp/happier-pwn',
    'happier tools call --source happier --tool save_memory --json || touch /tmp/happier-pwn',
    'happier tools call --source happier --tool save_memory --json | cat',
    'happier tools call --source happier --tool save_memory --json > /tmp/happier-pwn',
    'happier tools call --source happier --tool save_memory --json $(touch /tmp/happier-pwn)',
    'happier tools call --source happier --tool save_memory --json `touch /tmp/happier-pwn`',
    'happier tools call --source happier --tool save_memory --json\n touch /tmp/happier-pwn',
    'happier tools call --source happier --tool save_memory --json extra-token',
  ])('rejects shell bridge commands with trailing shell execution: %s', (command) => {
    expect(parseHappierToolsShellBridgeCommand(command)).toBeNull();
  });

  it.each([
    'happier tools list --json --json',
    'happier tools list --session-id one --session-id two',
    'happier tools call --source happier --source custom --tool think',
    'happier tools call --source happier --tool think --tool save_memory',
  ])('rejects duplicate flags: %s', (command) => {
    expect(parseHappierToolsShellBridgeCommand(command)).toBeNull();
  });

  it('rejects invalid JSON arguments', () => {
    expect(
      parseHappierToolsShellBridgeCommand(
        `happier tools call --source happier --tool save_memory --args-json '{'`,
      ),
    ).toBeNull();
  });
});
