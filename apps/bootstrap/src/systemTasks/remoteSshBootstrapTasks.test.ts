import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RemoteBootstrapMachineParams } from '@happier-dev/cli-common/systemTasks';
import { describe, expect, it, vi } from 'vitest';

import {
    installRemoteCliDefault,
    approveLocalRemoteAuthRequestDefault,
    resolveRemoteSshHostTrustDefault,
    runRemoteBootstrapCommandDefault,
} from './remoteSshBootstrapTasks.js';

const SCANNED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DIFFERENT_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function createFakeSsh(scenario: Readonly<{
    outputs?: readonly Readonly<{ status?: number; stdout?: string; stderr?: string }>[];
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
    readInvocations: () => string[][];
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-fake-ssh-'));
    const binDir = join(rootDir, 'bin');
    const sshPath = join(binDir, 'ssh');
    const scpPath = join(binDir, 'scp');
    const statePath = join(rootDir, 'scenario.json');
    const logPath = join(rootDir, 'invocations.log');

    writeFileSync(
        statePath,
        JSON.stringify({
            outputs: scenario.outputs ?? [],
        }),
        'utf8',
    );
    mkdirSync(binDir, { recursive: true });
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(
        sshPath,
        `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_SSH_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const outputs = Array.isArray(state.outputs) ? state.outputs : [];
const next = outputs.length > 0 ? outputs.shift() : { status: 0, stdout: '', stderr: '' };
state.outputs = outputs;
writeFileSync(statePath, JSON.stringify(state), 'utf8');

if (next.stdout) process.stdout.write(String(next.stdout));
if (next.stderr) process.stderr.write(String(next.stderr));
process.exit(Number(next.status ?? 0));
`,
        'utf8',
    );
    chmodSync(sshPath, 0o755);
    writeFileSync(
        scpPath,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const logPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
appendFileSync(logPath, JSON.stringify(['scp', ...process.argv.slice(2)]) + '\\n');
process.exit(0);
`,
        'utf8',
    );
    chmodSync(scpPath, 0o755);

    return {
        binDir,
        cleanup() {
            rmSync(rootDir, { recursive: true, force: true });
        },
        readInvocations() {
            const raw = readFileSync(logPath, 'utf8').trim();
            return raw ? raw.split('\n').map((line) => JSON.parse(line) as string[]) : [];
        },
    };
}

function withPatchedPath<T>(binDir: string, run: () => Promise<T>): Promise<T> {
    const previousPath = process.env.PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_SSH_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_SSH_LOG_PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.env.HAPPIER_FAKE_SSH_STATE_PATH = join(binDir, '..', 'scenario.json');
    process.env.HAPPIER_FAKE_SSH_LOG_PATH = join(binDir, '..', 'invocations.log');
    return run().finally(() => {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
        if (previousStatePath === undefined) {
            delete process.env.HAPPIER_FAKE_SSH_STATE_PATH;
        } else {
            process.env.HAPPIER_FAKE_SSH_STATE_PATH = previousStatePath;
        }
        if (previousLogPath === undefined) {
            delete process.env.HAPPIER_FAKE_SSH_LOG_PATH;
        } else {
            process.env.HAPPIER_FAKE_SSH_LOG_PATH = previousLogPath;
        }
    });
}

function createFakeSshKeyscan(scenario: Readonly<{
    status?: number;
    stdout?: string;
    stderr?: string;
}>): Readonly<{
    binDir: string;
    cleanup: () => void;
}> {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-fake-keyscan-'));
    const binDir = join(rootDir, 'bin');
    const keyscanPath = join(binDir, 'ssh-keyscan');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(
        keyscanPath,
        `#!/usr/bin/env node
const scenario = ${JSON.stringify({
    status: scenario.status ?? 0,
    stdout: scenario.stdout ?? '',
    stderr: scenario.stderr ?? '',
})};
if (scenario.stdout) process.stdout.write(String(scenario.stdout));
if (scenario.stderr) process.stderr.write(String(scenario.stderr));
process.exit(Number(scenario.status ?? 0));
`,
        'utf8',
    );
    chmodSync(keyscanPath, 0o755);

    return {
        binDir,
        cleanup() {
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
}

function createParsedRemoteBootstrapParams(channel: 'stable' | 'preview' | 'dev' = 'stable'): RemoteBootstrapMachineParams {
    return {
        ssh: {
            target: 'dev@example.test',
            auth: 'agent',
        },
        relay: {
            relayUrl: 'https://relay.example.test',
        },
        channel,
    };
}

describe('resolveRemoteSshHostTrustDefault', () => {
    it('pins the next SSH invocation to the exact host token the accepted trust persisted', async () => {
        // Reproduces the live blocker: `ssh-keyscan` ignores ~/.ssh/config and persists the alias
        // token, while the follow-up ssh honours `HostName` and verifies the rewritten address.
        const tempDir = mkdtempSync(join(tmpdir(), 'hsetup-known-hosts-alias-'));
        const knownHostsPath = join(tempDir, 'known_hosts');
        const aliasHostKey = 'cuihuis-mac-mini ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        const fakeKeyscan = createFakeSshKeyscan({ stdout: `${aliasHostKey}\n` });
        const fakeSsh = createFakeSsh({
            outputs: [{ status: 0, stdout: '{"ok":true,"kind":"auth_status","data":{"authenticated":false}}' }],
        });

        try {
            await withPatchedPath(fakeKeyscan.binDir, async () => {
                const resolution = await resolveRemoteSshHostTrustDefault({
                    ssh: { target: 'cuihuiai@cuihuis-mac-mini', auth: 'agent', knownHostsPath },
                    knownHostsMode: 'app',
                });
                if (resolution.status !== 'prompt') {
                    throw new Error('Expected an SSH trust prompt.');
                }
                await resolution.accept();
            });

            const persistedHostToken = readFileSync(knownHostsPath, 'utf8').trim().split(/\s+/u)[0];
            expect(persistedHostToken).toBe('cuihuis-mac-mini');

            await withPatchedPath(fakeSsh.binDir, async () => {
                await runRemoteBootstrapCommandDefault({
                    label: 'auth.status',
                    parsed: {
                        ...createParsedRemoteBootstrapParams(),
                        ssh: { target: 'cuihuiai@cuihuis-mac-mini', auth: 'agent', knownHostsPath },
                    },
                    auth: { mode: 'agent' },
                    knownHostsMode: 'app',
                });
            });

            const args = fakeSsh.readInvocations()[0] ?? [];
            expect(args).toContain(`UserKnownHostsFile=${knownHostsPath}`);
            expect(args).toContain('StrictHostKeyChecking=yes');
            expect(args).toContain(`HostKeyAlias=${persistedHostToken}`);
        } finally {
            fakeSsh.cleanup();
            fakeKeyscan.cleanup();
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('prompts to replace a mismatched persisted host key instead of trusting the host implicitly', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'hsetup-known-hosts-'));
        const knownHostsPath = join(tempDir, 'known_hosts');
        const fakeKeyscan = createFakeSshKeyscan({
            stdout: `${SCANNED_HOST_KEY}\n`,
        });

        writeFileSync(knownHostsPath, `${DIFFERENT_HOST_KEY}\n`, 'utf8');

        try {
            await withPatchedPath(fakeKeyscan.binDir, async () => {
                const resolution = await resolveRemoteSshHostTrustDefault({
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                        knownHostsPath,
                    },
                    knownHostsMode: 'app',
                });

                expect(resolution.status).toBe('prompt');
                if (resolution.status !== 'prompt') {
                    throw new Error('Expected an SSH trust prompt.');
                }
                expect(resolution.promptKind).toBe('ssh.replaceHostKey');
                expect(resolution.promptData).toEqual({
                    host: 'example.test',
                    keyType: 'ssh-ed25519',
                    fingerprint: expect.stringMatching(/^SHA256:/),
                    existingFingerprint: expect.stringMatching(/^SHA256:/),
                });

                await resolution.accept();

                expect(readFileSync(knownHostsPath, 'utf8').trim()).toBe(SCANNED_HOST_KEY);
            });
        } finally {
            fakeKeyscan.cleanup();
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed when an explicit trusted host key does not match the fresh scan result', async () => {
        const fakeKeyscan = createFakeSshKeyscan({
            stdout: `${SCANNED_HOST_KEY}\n`,
        });

        try {
            await withPatchedPath(fakeKeyscan.binDir, async () => {
                await expect(resolveRemoteSshHostTrustDefault({
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                        trustedHostKey: DIFFERENT_HOST_KEY,
                    },
                    knownHostsMode: 'app',
                })).rejects.toThrow(/trusted host key/i);
            });
        } finally {
            fakeKeyscan.cleanup();
        }
    });
});

describe('installRemoteCliDefault', () => {
    it('delegates remote CLI installation to the shared first-party installer', async () => {
        const invocations: Array<Record<string, unknown>> = [];

        await installRemoteCliDefault({
            parsed: createParsedRemoteBootstrapParams(),
            auth: { mode: 'agent' },
            knownHostsMode: 'system',
        }, {
            installRemoteFirstPartyComponent: async (params) => {
                invocations.push(params as Record<string, unknown>);
                return {
                    binaryPath: '$HOME/.happier/cli/current/happier',
                    versionId: '1.2.3',
                    source: 'https://example.test/happier.tgz',
                };
            },
        });

        expect(invocations).toEqual([
            expect.objectContaining({
                componentId: 'happier-cli',
                channel: 'stable',
                knownHostsMode: 'system',
            }),
        ]);
    });
});

describe('approveLocalRemoteAuthRequestDefault', () => {
    it('uses the managed local happier cli runner instead of depending on PATH resolution', async () => {
        const runLocalHappierJsonCommand = vi.fn(async (params: Readonly<{ args: readonly string[] }>) => {
            expect(params.args).toEqual([
                'auth',
                'approve',
                '--public-key',
                'public-key-123',
                '--json',
                '--persist',
                '--server-url=https://relay.example.test',
                '--webapp-url=https://relay.example.test',
            ]);
            return { success: true };
        });

        await approveLocalRemoteAuthRequestDefault({
            publicKey: 'public-key-123',
            parsed: createParsedRemoteBootstrapParams(),
        }, {
            runLocalHappierJsonCommand,
        });

        expect(runLocalHappierJsonCommand).toHaveBeenCalledTimes(1);
    });
});

describe('runRemoteBootstrapCommandDefault', () => {
    it('uses the channel-specific managed CLI path instead of a hardcoded bin shim path', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 0,
                    stdout: `${JSON.stringify({ ok: true, kind: 'auth_status', data: { authenticated: false } })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await runRemoteBootstrapCommandDefault({
                    label: 'auth.status',
                    parsed: createParsedRemoteBootstrapParams('preview'),
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                });
            });

            const remoteCommand = fakeSsh.readInvocations().at(-1)?.at(-1) ?? '';
            expect(remoteCommand).toContain('$HOME/.happier/cli-preview/current/happier auth status --json');
            expect(remoteCommand).not.toContain('$HOME/.happier/bin/happier');
        } finally {
            fakeSsh.cleanup();
        }
    });

    it('reads the structured not_authenticated auth.status envelope even though the remote command exits nonzero', async () => {
        // `happier auth status --json` prints the envelope on stdout and exits 1 when unauthenticated.
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 1,
                    stdout: `${JSON.stringify({ v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                const result = await runRemoteBootstrapCommandDefault({
                    label: 'auth.status',
                    parsed: createParsedRemoteBootstrapParams(),
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                });

                expect(result).toEqual({ ok: true, data: { authenticated: false } });
            });
        } finally {
            fakeSsh.cleanup();
        }
    });

    it('stays fail-closed for auth.status when a nonzero exit is not an explicit not_authenticated envelope', async () => {
        const scenarios: readonly Readonly<{ name: string; status: number; stdout: string; stderr?: string }>[] = [
            {
                name: 'ssh transport failure',
                status: 255,
                stdout: '',
                stderr: 'Host key verification failed.\n',
            },
            {
                name: 'malformed stdout',
                status: 1,
                stdout: 'not json at all\n',
            },
            {
                name: 'unexpected error code',
                status: 1,
                stdout: `${JSON.stringify({ v: 1, ok: false, kind: 'auth_status', error: { code: 'auth_unavailable' } })}\n`,
            },
            {
                name: 'different envelope kind',
                status: 1,
                stdout: `${JSON.stringify({ v: 1, ok: false, kind: 'server_configure', error: { code: 'not_authenticated' } })}\n`,
            },
        ];

        for (const scenario of scenarios) {
            const fakeSsh = createFakeSsh({
                outputs: [{ status: scenario.status, stdout: scenario.stdout, stderr: scenario.stderr }],
            });
            try {
                await withPatchedPath(fakeSsh.binDir, async () => {
                    await expect(runRemoteBootstrapCommandDefault({
                        label: 'auth.status',
                        parsed: createParsedRemoteBootstrapParams(),
                        auth: { mode: 'agent' },
                        knownHostsMode: 'system',
                    })).rejects.toThrow();
                });
            } finally {
                fakeSsh.cleanup();
            }
        }
    });

    it('stays fail-closed for zero-exit auth.status output without an explicit success envelope', async () => {
        const scenarios = [
            '',
            '{}\n',
            `${JSON.stringify({ ok: true, kind: 'server_configure', data: {} })}\n`,
            `${JSON.stringify({ ok: true, kind: 'auth_status', data: {} })}\n`,
            `${JSON.stringify({ ok: true, kind: 'auth_status', data: { authenticated: 'yes' } })}\n`,
        ];

        for (const stdout of scenarios) {
            const fakeSsh = createFakeSsh({
                outputs: [{ status: 0, stdout }],
            });
            try {
                await withPatchedPath(fakeSsh.binDir, async () => {
                    await expect(runRemoteBootstrapCommandDefault({
                        label: 'auth.status',
                        parsed: createParsedRemoteBootstrapParams(),
                        auth: { mode: 'agent' },
                        knownHostsMode: 'system',
                    })).rejects.toThrow();
                });
            } finally {
                fakeSsh.cleanup();
            }
        }
    });

    it('keeps other bootstrap labels fail-closed on a nonzero remote exit even with parseable stdout', async () => {
        const fakeSsh = createFakeSsh({
            outputs: [
                {
                    status: 1,
                    stdout: `${JSON.stringify({ v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } })}\n`,
                },
            ],
        });

        try {
            await withPatchedPath(fakeSsh.binDir, async () => {
                await expect(runRemoteBootstrapCommandDefault({
                    label: 'server.configure',
                    parsed: createParsedRemoteBootstrapParams(),
                    auth: { mode: 'agent' },
                    knownHostsMode: 'system',
                })).rejects.toThrow();
            });
        } finally {
            fakeSsh.cleanup();
        }
    });
});
