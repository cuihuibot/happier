import { describe, expect, it } from 'vitest';

import { haveEqualLiteralShellWords, parseHappierToolsShellBridgeCommand } from './happierToolsShellBridge.js';

describe('literal shell command equivalence', () => {
  it.each([
    ['"/opt/happier" tools list', "'/opt/happier' 'tools' 'list'"],
    ["'/opt/happier' tools call --args-json '{\"value\":\"$HOME * ~ #\"}'", "'/opt/happier' 'tools' 'call' '--args-json' '{\"value\":\"$HOME * ~ #\"}'"],
    ['ENV="literal value" /opt/happier tools list', "ENV='literal value' '/opt/happier' 'tools' 'list'"],
  ])('accepts equivalent literal shell words: %s', (actual, expected) => {
    expect(haveEqualLiteralShellWords(actual, expected)).toBe(true);
  });

  it.each([
    ['$HOME', "'$HOME'"], ['"${HOME}"', "'${HOME}'"], ['~', "'~'"],
    ['*', "'*'"], ['[ab]', "'[ab]'"], ['{a,b}', "'{a,b}'"], ['#comment', "'#comment'"],
    ['(word)', "'(word)'"], ['"\\a"', "'a'"], ["word ''", "'word'"],
    ['word; other', "'word;' 'other'"], ['$(pwd)', "'$(pwd)'"], ['`pwd`', "'`pwd`'"],
    ['/tmp/happier tools list', "'/opt/happier' 'tools' 'list'"],
    ["ENV='other' /opt/happier tools list", "ENV='literal' '/opt/happier' 'tools' 'list'"],
  ])('rejects nonliteral or changed words: %s', (actual, expected) => {
    expect(haveEqualLiteralShellWords(actual, expected)).toBe(false);
  });
});

describe('parseHappierToolsShellBridgeCommand', () => {
  it('recognizes a standalone package-dist entrypoint without assuming an installation directory name', () => {
    expect(parseHappierToolsShellBridgeCommand(
      "'/opt/happier/happier' '/opt/happier/package-dist/index.mjs' tools list --session-agent-bridge --session-id host-parent --json",
    )).toMatchObject({ kind: 'list', sessionAgentBridge: true, sessionId: 'host-parent' });
  });

  it.each([
    ['/opt/happier/cli/versions/test/happier', '/opt/happier/cli/versions/test/package-dist/index.mjs'],
    ['C:\\Happier\\cli\\versions\\test\\happier.exe', 'C:\\Happier\\cli\\versions\\test\\package-dist\\index.mjs'],
    ['/opt/bun/bin/bun', '/opt/happier/cli/versions/test/package-dist/index.mjs'],
  ])('parses packaged session-agent calls launched by %s', (executable, entrypoint) => {
    const command = `'${executable}' '${entrypoint}' 'tools' 'call' '--session-agent-bridge' '--session-id' 'host-parent' '--directory' '/workspace/worker' '--source' 'happier' '--tool' 'action_execute' '--args-json' '{"actionId":"session.message.send","input":{"sessionId":"host-parent","message":"Done","wait":false}}' '--json'`;
    expect(parseHappierToolsShellBridgeCommand(command)).toMatchObject({
      kind: 'call',
      sessionAgentBridge: true,
      sessionId: 'host-parent',
      directory: '/workspace/worker',
      source: 'happier',
      tool: 'action_execute',
      args: { actionId: 'session.message.send', input: { sessionId: 'host-parent', message: 'Done', wait: false } },
    });
  });

  it.each(['/opt/happier/happier', 'C:\\Happier\\happier.exe'])('parses direct standalone discovery from %s', (executable) => {
    expect(parseHappierToolsShellBridgeCommand(
      `'${executable}' tools list --session-agent-bridge --session-id host-parent --json`,
    )).toMatchObject({ kind: 'list', sessionAgentBridge: true, sessionId: 'host-parent', json: true });
  });

  it.each([
    "'/opt/unknown' '/opt/happier/cli/package-dist/index.mjs' tools list --json",
    "'/opt/happier-not-the-cli' '/opt/happier/cli/package-dist/index.mjs' tools list --json",
    "'/opt/happier/happier' '/tmp/unrelated.mjs' tools list --json",
    "'/opt/happier/happier' '/opt/happier/cli/package-dist/index.mjs' tools list --session-agent-bridge --session-agent-bridge",
    "'/opt/happier/happier' '/opt/happier/cli/package-dist/index.mjs' tools list --json && echo unrelated",
  ])('rejects invalid standalone bridge routes: %s', (command) => {
    expect(parseHappierToolsShellBridgeCommand(command)).toBeNull();
  });

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
