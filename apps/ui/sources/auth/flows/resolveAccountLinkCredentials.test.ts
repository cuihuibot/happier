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

    it('preserves the released legacy interpretation when the account publishes no evidence', async () => {
        const onUnverifiedFamily = vi.fn();
        const credentials = await resolveAccountLinkCredentials({
            token: 'transferred-token',
            payload: legacySecretBytes,
            fetchSettingsCiphertext: async () => null,
            onUnverifiedFamily,
        });

        expect(credentials).toEqual({
            token: 'transferred-token',
            secret: encodeBase64(legacySecretBytes, 'base64url'),
        });
        expect(onUnverifiedFamily).toHaveBeenCalledExactlyOnceWith('account_evidence_absent');
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
