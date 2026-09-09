import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('expo-secure-store', () => ({}));

import {
    deriveAccountMachineKeyFromRecoverySecret,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import {
    AccountLinkKeyFamilyError,
    resolveAccountLinkCredentials,
} from '@/auth/flows/resolveAccountLinkCredentials';

const dataKeyBytes = new Uint8Array(32).fill(9);
const legacySecretBytes = new Uint8Array(32).fill(3);

function sealSettings(machineKey: Uint8Array): string {
    let counter = 0;
    return sealAccountScopedBlobCiphertext({
        kind: 'account_settings',
        material: { type: 'dataKey', machineKey },
        payload: { expoPushToken: null },
        randomBytes: (length) => Uint8Array.from({ length }, () => (counter = (counter + 5) % 251)),
    });
}

describe('resolveAccountLinkCredentials', () => {
    it('stores an untagged dataKey transfer in dataKey shape after proving the family', async () => {
        const fetchSettingsCiphertext = vi.fn(async () => sealSettings(dataKeyBytes));
        const credentials = await resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: dataKeyBytes,
            fetchSettingsCiphertext,
        });

        expect(fetchSettingsCiphertext).toHaveBeenCalledExactlyOnceWith('transferred-token');
        if (!('encryption' in credentials)) throw new Error('expected dataKey credentials');
        expect(credentials.encryption.machineKey).toBe(encodeBase64(dataKeyBytes));
    });

    it('stores an untagged legacy transfer exactly as before', async () => {
        const credentials = await resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: legacySecretBytes,
            fetchSettingsCiphertext: async () =>
                sealSettings(deriveAccountMachineKeyFromRecoverySecret(legacySecretBytes)),
        });

        expect(credentials).toEqual({
            token: 'transferred-token',
            secret: encodeBase64(legacySecretBytes, 'base64url'),
        });
    });

    it('refuses to store guessed legacy credentials when the account publishes no readable encrypted settings', async () => {
        // A raw dataKey transfer whose account exposes no settings envelope. Other encrypted
        // account-scoped material (machines, sessions) may still exist, so absence of settings is
        // not proof of a legacy account and must never yield storable credentials.
        await expect(resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: dataKeyBytes,
            fetchSettingsCiphertext: async () => null,
        })).rejects.toMatchObject({
            name: 'AccountLinkKeyFamilyError',
            reason: 'account_evidence_absent',
        });
    });

    it('refuses a blank or legacy account of unknown family rather than defaulting to legacy', async () => {
        for (const ciphertext of [null, '', '   ']) {
            await expect(resolveAccountLinkCredentials({
                token: 'transferred-token',
                payload: legacySecretBytes,
                fetchSettingsCiphertext: async () => ciphertext,
            })).rejects.toMatchObject({
                name: 'AccountLinkKeyFamilyError',
                reason: 'account_evidence_absent',
            });
        }
    });

    it('fails closed on malformed settings ciphertext', async () => {
        await expect(resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: dataKeyBytes,
            fetchSettingsCiphertext: async () => 'not-a-valid-envelope',
        })).rejects.toMatchObject({
            name: 'AccountLinkKeyFamilyError',
            reason: 'key_rejected_by_account_evidence',
        });
    });

    it('exposes no option that could re-enable accepting an unproven family', () => {
        // Guards the owner ruling: the resolver must not regain a callback or flag that lets a
        // caller opt back into storing credentials for an unproven key family.
        const source = resolveAccountLinkCredentials.toString();
        expect(source).not.toContain('onUnverifiedFamily');
        expect(resolveAccountLinkCredentials.length).toBe(1);
    });

    it('fails closed when the account evidence rejects the transferred key', async () => {
        await expect(resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: new Uint8Array(32).fill(1),
            fetchSettingsCiphertext: async () => sealSettings(dataKeyBytes),
        })).rejects.toMatchObject({
            name: 'AccountLinkKeyFamilyError',
            reason: 'key_rejected_by_account_evidence',
        });
    });

    it('propagates an evidence read failure instead of guessing a family', async () => {
        await expect(resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: dataKeyBytes,
            fetchSettingsCiphertext: async () => {
                throw new AccountLinkKeyFamilyError('evidence_unavailable');
            },
        })).rejects.toMatchObject({ reason: 'evidence_unavailable' });
    });
});
