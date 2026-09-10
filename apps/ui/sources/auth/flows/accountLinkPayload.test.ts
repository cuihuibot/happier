import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('expo-secure-store', () => ({}));

import tweetnacl from 'tweetnacl';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import {
    buildCredentialsForAccountLinkKeyFamily,
    classifyAccountLinkKeyFamily,
    encodeAccountLinkPayload,
} from '@/auth/flows/accountLinkPayload';

const dataKeyBytes = new Uint8Array(32).fill(9);
const legacySecretBytes = new Uint8Array(32).fill(3);

/**
 * Byte-for-byte reimplementation of the encoder that shipped before this repair. Emission must stay
 * identical so every already-deployed receiver keeps seeing exactly the payload it supports.
 */
function releasedAccountLinkSecretBytes(credentials: AuthCredentials): Uint8Array {
    if (isLegacyAuthCredentials(credentials)) {
        return decodeBase64(credentials.secret, 'base64url');
    }
    return decodeBase64(credentials.encryption.machineKey, 'base64');
}

function sealSettings(machineKey: Uint8Array): string {
    let counter = 0;
    return sealAccountScopedBlobCiphertext({
        kind: 'account_settings',
        material: { type: 'dataKey', machineKey },
        payload: { expoPushToken: null },
        randomBytes: (length) => Uint8Array.from({ length }, () => (counter = (counter + 7) % 251)),
    });
}

const dataKeyAccountSettings = sealSettings(dataKeyBytes);
const legacyAccountSettings = sealSettings(deriveAccountMachineKeyFromRecoverySecret(legacySecretBytes));

const legacyCredentials: AuthCredentials = {
    token: 'token',
    secret: encodeBase64(legacySecretBytes, 'base64url'),
};
const dataKeyCredentials: AuthCredentials = {
    token: 'token',
    encryption: {
        publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(dataKeyBytes).publicKey),
        machineKey: encodeBase64(dataKeyBytes),
    },
};

describe('encodeAccountLinkPayload (new producer -> old receiver)', () => {
    it('emits the released legacy bytes unchanged', () => {
        const payload = encodeAccountLinkPayload(legacyCredentials);
        expect(Array.from(payload)).toEqual(Array.from(releasedAccountLinkSecretBytes(legacyCredentials)));
        expect(Array.from(payload)).toEqual(Array.from(legacySecretBytes));
    });

    it('emits the released dataKey bytes unchanged, with no added tag an old receiver cannot parse', () => {
        const payload = encodeAccountLinkPayload(dataKeyCredentials);
        expect(Array.from(payload)).toEqual(Array.from(releasedAccountLinkSecretBytes(dataKeyCredentials)));
        expect(payload.length).toBe(32);
    });
});

describe('classifyAccountLinkKeyFamily (old producer -> new receiver)', () => {
    it('proves the dataKey family for the untagged key an existing CLI approver sends', () => {
        expect(classifyAccountLinkKeyFamily({
            payload: dataKeyBytes,
            settingsCiphertext: dataKeyAccountSettings,
        })).toEqual({ resolved: true, family: 'dataKey' });
    });

    it('proves the legacy family for a legacy master secret', () => {
        expect(classifyAccountLinkKeyFamily({
            payload: legacySecretBytes,
            settingsCiphertext: legacyAccountSettings,
        })).toEqual({ resolved: true, family: 'legacy' });
    });

    it('refuses a key that authenticates against neither family instead of guessing', () => {
        expect(classifyAccountLinkKeyFamily({
            payload: new Uint8Array(32).fill(1),
            settingsCiphertext: dataKeyAccountSettings,
        })).toEqual({ resolved: false, reason: 'key_rejected_by_account_evidence' });
    });

    it('reports absent evidence distinctly from a rejected key, and never as resolved', () => {
        for (const settingsCiphertext of [null, '', '   ']) {
            const resolution = classifyAccountLinkKeyFamily({ payload: dataKeyBytes, settingsCiphertext });
            expect(resolution).toEqual({ resolved: false, reason: 'account_evidence_absent' });
            // Distinct cause, same disposition: absent evidence is a refusal, not a default.
            expect(resolution.resolved).toBe(false);
        }
    });

    it('refuses a payload length it cannot classify', () => {
        expect(classifyAccountLinkKeyFamily({ payload: new Uint8Array(31), settingsCiphertext: dataKeyAccountSettings }))
            .toEqual({ resolved: false, reason: 'unsupported_payload_length' });
        expect(classifyAccountLinkKeyFamily({ payload: new Uint8Array(34), settingsCiphertext: dataKeyAccountSettings }))
            .toEqual({ resolved: false, reason: 'unsupported_payload_length' });
    });

    it('refuses corrupt evidence rather than falling back to a key family', () => {
        expect(classifyAccountLinkKeyFamily({ payload: dataKeyBytes, settingsCiphertext: 'not-base64!!' }))
            .toEqual({ resolved: false, reason: 'key_rejected_by_account_evidence' });
    });
});

describe('buildCredentialsForAccountLinkKeyFamily', () => {
    it('stores a legacy transfer exactly as the released login path did', () => {
        expect(buildCredentialsForAccountLinkKeyFamily({
            token: 'receiver',
            payload: legacySecretBytes,
            family: 'legacy',
        })).toEqual({ token: 'receiver', secret: encodeBase64(legacySecretBytes, 'base64url') });
    });

    it('stores a dataKey transfer as a content key pair with the matching public key', () => {
        const credentials = buildCredentialsForAccountLinkKeyFamily({
            token: 'receiver',
            payload: dataKeyBytes,
            family: 'dataKey',
        });
        if (!('encryption' in credentials)) throw new Error('expected dataKey credentials');
        expect(credentials.token).toBe('receiver');
        expect(credentials.encryption.machineKey).toBe(encodeBase64(dataKeyBytes));
        expect(credentials.encryption.publicKey)
            .toBe(encodeBase64(tweetnacl.box.keyPair.fromSecretKey(dataKeyBytes).publicKey));
    });

    it('rejects a key length it cannot store', () => {
        expect(() => buildCredentialsForAccountLinkKeyFamily({
            token: 'receiver',
            payload: new Uint8Array(31),
            family: 'dataKey',
        })).toThrow(/Invalid account link key length/);
    });
});
