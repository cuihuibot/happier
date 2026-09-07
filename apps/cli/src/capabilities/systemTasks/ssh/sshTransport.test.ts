import { describe, expect, it } from 'vitest';

import {
  buildScpCommand,
  buildSshCommand,
  redactRemoteBootstrapPayload,
  SshKnownHostsStore,
} from './sshTransport';

describe('buildSshCommand', () => {
  it('builds strict ssh invocations with an isolated known_hosts file and selected identity', () => {
    expect(buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@example.test',
      remoteCommand: ['bash', '-lc', 'echo ok'],
      sshConfigFile: '/tmp/lima-ssh.config',
      knownHostsPath: '/tmp/happier-known-hosts',
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    })).toEqual({
      command: 'ssh',
      args: [
        '-F', '/tmp/lima-ssh.config',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=/tmp/happier-known-hosts',
        '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'HostKeyAlias=example.test',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=2',
        '-o', 'LogLevel=ERROR',
        'dev@example.test',
        'bash',
        '-lc',
        'echo ok',
      ],
      redactedLabel: 'ssh dev@example.test bash -lc …',
    });

    expect(buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@example.test',
      remoteCommand: ['uname', '-s'],
      sshConfigFile: '/tmp/lima-ssh.config',
      knownHostsPath: '/tmp/happier-known-hosts',
      auth: { mode: 'keyFile', privateKeyPath: '/Users/alex/.ssh/id_ed25519' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args).toContain('/Users/alex/.ssh/id_ed25519');
  });

  it('pins app-managed host-key lookup to the trusted target token so ssh_config HostName rewrites cannot bypass it', () => {
    const aliasArgs = buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@alias.internal',
      remoteCommand: ['uname', '-s'],
      knownHostsPath: '/tmp/happier-known-hosts',
      knownHostsMode: 'app',
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args;
    expect(aliasArgs).toContain('HostKeyAlias=alias.internal');

    const portArgs = buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@alias.internal',
      remoteCommand: ['uname', '-s'],
      knownHostsPath: '/tmp/happier-known-hosts',
      knownHostsMode: 'app',
      port: 2222,
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args;
    expect(portArgs).toContain('HostKeyAlias=[alias.internal]:2222');

    const systemArgs = buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@alias.internal',
      remoteCommand: ['uname', '-s'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args;
    expect(systemArgs.some((arg) => arg.startsWith('HostKeyAlias='))).toBe(false);
  });

  it('pins the caller-resolved known_hosts token so an ssh_config alias verifies the token the trust scan accepted', () => {
    const sshArgs = buildSshCommand({
      sshBin: 'ssh',
      target: 'lima-alias',
      remoteCommand: ['uname', '-s'],
      sshConfigFile: '/tmp/lima-ssh.config',
      knownHostsPath: '/tmp/happier-known-hosts',
      knownHostsMode: 'app',
      hostKeyAlias: '[127.0.0.1]:50977',
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args;
    expect(sshArgs).toContain('HostKeyAlias=[127.0.0.1]:50977');
    expect(sshArgs).not.toContain('HostKeyAlias=lima-alias');

    const scpArgs = buildScpCommand({
      scpBin: 'scp',
      target: 'lima-alias',
      localPath: '/tmp/payload',
      remotePath: '/home/dev/payload',
      sshConfigFile: '/tmp/lima-ssh.config',
      knownHostsPath: '/tmp/happier-known-hosts',
      knownHostsMode: 'app',
      hostKeyAlias: '[127.0.0.1]:50977',
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args;
    expect(scpArgs).toContain('HostKeyAlias=[127.0.0.1]:50977');
    expect(scpArgs).not.toContain('HostKeyAlias=lima-alias');
  });
});

describe('redactRemoteBootstrapPayload', () => {  it('removes auth secrets and state file paths before any prompt/event payload is surfaced', () => {
    expect(redactRemoteBootstrapPayload({
      publicKey: 'pub-key',
      claimSecret: 'top-secret',
      stateFile: '/tmp/happier/state.json',
      webappUrl: 'https://relay.example.test',
      supportsV2: true,
    })).toEqual({
      publicKey: 'pub-key',
      webappUrl: 'https://relay.example.test',
      supportsV2: true,
    });
  });
});

describe('SshKnownHostsStore', () => {
  it('records trusted keys, detects mismatches, and forgets hosts deterministically', () => {
    const store = new SshKnownHostsStore({
      initialText: '',
    });

    expect(store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    })).toEqual({
      status: 'added',
      fingerprint: expect.stringMatching(/^SHA256:/),
    });

    expect(store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    })).toEqual({
      status: 'unchanged',
      fingerprint: expect.stringMatching(/^SHA256:/),
    });

    expect(store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    })).toEqual({
      status: 'mismatch',
      fingerprint: expect.stringMatching(/^SHA256:/),
      existingFingerprint: expect.stringMatching(/^SHA256:/),
    });

    store.forget('example.test');
    expect(store.toString()).toBe('');
  });
});
