import { describe, expect, it } from 'vitest';

import { resolveSshKnownHostsHostToken, resolveSshKnownHostTrust } from './sshHostTrust.js';

const SCANNED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DIFFERENT_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('resolveSshKnownHostTrust', () => {
  it('fails closed when an explicit trusted host key does not match the fresh ssh-keyscan result', () => {
    expect(resolveSshKnownHostTrust({
      knownHostsText: `${SCANNED_HOST_KEY}\n`,
      scannedHostKeyLine: SCANNED_HOST_KEY,
      trustedHostKey: DIFFERENT_HOST_KEY,
    })).toEqual({
      status: 'rejected',
      reason: 'trustedHostKeyMismatch',
      scanned: expect.objectContaining({
        host: 'example.test',
        keyType: 'ssh-ed25519',
        key: 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
      message: expect.stringContaining('does not match'),
      trustedFingerprint: expect.stringMatching(/^SHA256:/),
    });
  });

  it('persists a matching explicit trusted host key into known_hosts state', () => {
    expect(resolveSshKnownHostTrust({
      scannedHostKeyLine: SCANNED_HOST_KEY,
      trustedHostKey: SCANNED_HOST_KEY,
    })).toEqual({
      status: 'trusted',
      scanned: expect.objectContaining({
        host: 'example.test',
        keyType: 'ssh-ed25519',
      }),
      nextKnownHostsText: SCANNED_HOST_KEY,
    });
  });
});

describe('resolveSshKnownHostsHostToken', () => {
  it('derives the known_hosts token from the requested target so a rewritten address cannot be trusted implicitly', () => {
    expect(resolveSshKnownHostsHostToken({ target: 'cuihuiai@cuihuis-mac-mini' })).toBe('cuihuis-mac-mini');
    expect(resolveSshKnownHostsHostToken({ target: 'cuihuis-mac-mini', port: 22 })).toBe('cuihuis-mac-mini');
    expect(resolveSshKnownHostsHostToken({ target: 'dev@example.test', port: 2222 })).toBe('[example.test]:2222');
    expect(resolveSshKnownHostsHostToken({ target: '   ' })).toBe('');
  });

  it('does not match a known_hosts entry stored under the resolved address', () => {
    const token = resolveSshKnownHostsHostToken({ target: 'cuihuiai@cuihuis-mac-mini' });
    const addressKeyedEntry = `100.85.17.39 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;

    const trust = resolveSshKnownHostTrust({
      knownHostsText: `${addressKeyedEntry}\n`,
      scannedHostKeyLine: `${token} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
    });

    expect(trust.status).toBe('prompt');
    if (trust.status !== 'prompt') throw new Error('expected a trust prompt');
    expect(trust.promptKind).toBe('ssh.trustHost');
    expect(trust.scanned.host).toBe(token);
  });
});
