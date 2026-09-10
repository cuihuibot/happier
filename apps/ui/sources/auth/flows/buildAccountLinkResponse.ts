import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeAccountLinkPayload } from '@/auth/flows/accountLinkPayload';
import { encryptBox } from '@/encryption/libsodium';

export function buildAccountLinkResponse(credentials: AuthCredentials, recipientPublicKey: Uint8Array): Uint8Array {
    return encryptBox(encodeAccountLinkPayload(credentials), recipientPublicKey);
}
