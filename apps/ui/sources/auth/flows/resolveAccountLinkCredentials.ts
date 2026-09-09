import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import {
    buildCredentialsForAccountLinkKeyFamily,
    classifyAccountLinkKeyFamily,
    type AccountLinkKeyFamilyFailureReason,
} from '@/auth/flows/accountLinkPayload';

export class AccountLinkKeyFamilyError extends Error {
    readonly reason: AccountLinkKeyFamilyFailureReason | 'evidence_unavailable';

    constructor(reason: AccountLinkKeyFamilyFailureReason | 'evidence_unavailable') {
        super(`Unable to verify the transferred account key family: ${reason}`);
        this.name = 'AccountLinkKeyFamilyError';
        this.reason = reason;
    }
}

/**
 * Read the account's own encrypted settings envelope with the freshly transferred token only.
 *
 * This is a read. It stores nothing, initializes no writer, and never decrypts with a key that has
 * not already been proven, so it is safe to run before credentials are persisted.
 */
export async function fetchAccountSettingsCiphertext(token: string): Promise<string | null> {
    const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    } as const;

    const v2 = await serverFetch('/v2/account/settings', { headers: authHeaders }, { includeAuth: false });
    if (v2.ok) {
        const parsed = AccountSettingsV2GetResponseSchema.safeParse(await v2.json());
        if (!parsed.success) {
            throw new AccountLinkKeyFamilyError('evidence_unavailable');
        }
        const content = parsed.data.content;
        return content && content.t === 'encrypted' ? content.c : null;
    }
    if (v2.status !== 404) {
        throw new AccountLinkKeyFamilyError('evidence_unavailable');
    }

    // Back-compat: older servers only support v1.
    const v1 = await serverFetch('/v1/account/settings', { headers: authHeaders }, { includeAuth: false });
    if (!v1.ok) {
        throw new AccountLinkKeyFamilyError('evidence_unavailable');
    }
    const data = (await v1.json()) as { settings?: string | null };
    return typeof data?.settings === 'string' && data.settings ? data.settings : null;
}

/**
 * Turn an account-link transfer into storable credentials.
 *
 * The transferred payload is 32 untagged key bytes whose family the sender does not state, so the
 * family is proven cryptographically against the account's own encrypted settings envelope before
 * anything is stored. A key the account's evidence rejects, or that somehow satisfies both
 * families, fails closed; no key is ever guessed, reinterpreted, or replaced with freshly generated
 * material.
 *
 * When the account publishes no encrypted blob at all there is nothing to prove a family against
 * and nothing yet encrypted to misread. Refusing there would newly break pairing for accounts that
 * link successfully today, so this preserves the exact released interpretation (legacy) instead.
 * That is the shipped behavior, unchanged — not a new guess — and it is reported to the caller.
 */
export async function resolveAccountLinkCredentials(params: Readonly<{
    token: string;
    payload: Uint8Array;
    fetchSettingsCiphertext?: (token: string) => Promise<string | null>;
    onUnverifiedFamily?: (reason: 'account_evidence_absent') => void;
}>): Promise<AuthCredentials> {
    const fetchCiphertext = params.fetchSettingsCiphertext ?? fetchAccountSettingsCiphertext;
    const settingsCiphertext = await fetchCiphertext(params.token);

    const resolution = classifyAccountLinkKeyFamily({
        payload: params.payload,
        settingsCiphertext,
    });

    if (!resolution.resolved) {
        if (resolution.reason !== 'account_evidence_absent') {
            throw new AccountLinkKeyFamilyError(resolution.reason);
        }
        params.onUnverifiedFamily?.('account_evidence_absent');
        return buildCredentialsForAccountLinkKeyFamily({
            token: params.token,
            payload: params.payload,
            family: 'legacy',
        });
    }

    return buildCredentialsForAccountLinkKeyFamily({
        token: params.token,
        payload: params.payload,
        family: resolution.family,
    });
}
