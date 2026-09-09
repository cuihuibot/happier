import { deriveBoxPublicKeyFromSecretKey, openAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';

export const ACCOUNT_LINK_KEY_BYTES = 32;

export type AccountLinkKeyFamily = 'legacy' | 'dataKey';

/**
 * `account_evidence_absent` names a distinct *cause* — the account published no readable encrypted
 * settings envelope to test against — but it is not a licence to proceed. Absence of one encrypted
 * settings envelope does not establish that encrypted machines, sessions, or other account-scoped
 * records are absent, and it says nothing about the family future writes will be sealed under. Every
 * reason in this union is therefore a refusal: none of them may produce storable credentials.
 */
export type AccountLinkKeyFamilyFailureReason =
    | 'unsupported_payload_length'
    | 'account_evidence_absent'
    | 'key_rejected_by_account_evidence'
    | 'ambiguous_evidence';

export type AccountLinkKeyFamilyResolution =
    | Readonly<{ resolved: true; family: AccountLinkKeyFamily }>
    | Readonly<{ resolved: false; reason: AccountLinkKeyFamilyFailureReason }>;

/**
 * Account-link transfers carry 32 raw key bytes and always have. Those bytes mean different things
 * per credential family: a legacy account transfers its master recovery secret, while a dataKey
 * account transfers its account content key. A receiver that assumes the legacy family for a
 * dataKey transfer derives a *different* content key from the same bytes, leaving every
 * account-scoped blob unreadable on the linked client.
 *
 * The wire format is deliberately NOT changed. The account-link flow has no client-only capability
 * channel: `/v1/auth/account/request` carries only the requester's box public key, and
 * `parseAccountConnectDeepLink` consumes the whole deep-link query as that key, so an added tag or
 * suffix would corrupt already-shipped approvers. Tagging emissions would break existing receivers
 * without fixing the actual failing case, which is an *old* approver sending untagged bytes.
 *
 * The family is instead recovered on the receiving side from an existing authoritative discriminator
 * the account already publishes: its account-scoped settings envelope. `resolveMachineKey` in the
 * shared protocol derives the settings secretbox key differently per family — raw bytes for
 * `dataKey`, `SHA-512(deriveKey(secret, 'Happy EnCoder', ['content']))[0..32]` for `legacy` — so an
 * authenticated secretbox open under each candidate is a cryptographic family proof. It is
 * read-only and one-time, and runs before any credential is stored or any write is initialized.
 *
 * Proof is required, never assumed. If no candidate is proven — including when the account exposes
 * no readable encrypted settings at all — the transfer is refused rather than resolved to a default.
 * A blank or plain account is not evidence that the account holds nothing encrypted, and it cannot
 * predict the family of later writes, so storing a guessed credential there would reintroduce the
 * exact silent wrong-key divergence this discriminator exists to prevent.
 */
export function encodeAccountLinkPayload(credentials: AuthCredentials): Uint8Array {
    if (isLegacyAuthCredentials(credentials)) {
        return decodeBase64(credentials.secret, 'base64url');
    }
    return decodeBase64(credentials.encryption.machineKey, 'base64');
}

function canOpenAccountSettings(ciphertext: string, key: Uint8Array, family: AccountLinkKeyFamily): boolean {
    try {
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: family === 'dataKey'
                ? { type: 'dataKey', machineKey: key }
                : { type: 'legacy', secret: key },
            ciphertext,
        });
        return opened !== null && opened.value !== null && typeof opened.value === 'object';
    } catch {
        return false;
    }
}

/**
 * Classify a transferred 32-byte account-link key against authenticated account evidence.
 *
 * Never guesses, logs, echoes or re-encrypts account data. Each refusal carries its own reason so
 * the caller can distinguish "no evidence exists" from "this key is wrong for this account".
 */
export function classifyAccountLinkKeyFamily(params: Readonly<{
    payload: Uint8Array;
    settingsCiphertext: string | null;
}>): AccountLinkKeyFamilyResolution {
    if (params.payload.length !== ACCOUNT_LINK_KEY_BYTES) {
        return { resolved: false, reason: 'unsupported_payload_length' };
    }

    const ciphertext = typeof params.settingsCiphertext === 'string' ? params.settingsCiphertext.trim() : '';
    if (!ciphertext) {
        return { resolved: false, reason: 'account_evidence_absent' };
    }

    const opensAsDataKey = canOpenAccountSettings(ciphertext, params.payload, 'dataKey');
    const opensAsLegacy = canOpenAccountSettings(ciphertext, params.payload, 'legacy');

    if (opensAsDataKey && opensAsLegacy) {
        return { resolved: false, reason: 'ambiguous_evidence' };
    }
    if (opensAsDataKey) {
        return { resolved: true, family: 'dataKey' };
    }
    if (opensAsLegacy) {
        return { resolved: true, family: 'legacy' };
    }
    return { resolved: false, reason: 'key_rejected_by_account_evidence' };
}

/**
 * Build storable credentials for an already-proven key family. `legacy` reproduces exactly what the
 * previous `auth.login(token, base64url(secret))` path stored, so legacy accounts are untouched.
 */
export function buildCredentialsForAccountLinkKeyFamily(params: Readonly<{
    token: string;
    payload: Uint8Array;
    family: AccountLinkKeyFamily;
}>): AuthCredentials {
    if (params.payload.length !== ACCOUNT_LINK_KEY_BYTES) {
        throw new Error(`Invalid account link key length: ${params.payload.length}`);
    }
    if (params.family === 'legacy') {
        return { token: params.token, secret: encodeBase64(params.payload, 'base64url') };
    }
    return {
        token: params.token,
        encryption: {
            publicKey: encodeBase64(deriveBoxPublicKeyFromSecretKey(params.payload)),
            machineKey: encodeBase64(params.payload),
        },
    };
}
