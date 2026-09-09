import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { installRestoreScanComputerQrViewCommonModuleMocks } from './restoreScanComputerQrViewTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    __DEV__?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as ReactActEnvironmentGlobal).__DEV__ = true;
type ExpoGlobalShim = NonNullable<typeof globalThis.expo>;
const expoShim = {
    EventEmitter: class {} as unknown as ExpoGlobalShim['EventEmitter'],
    SharedRef: class {} as unknown as ExpoGlobalShim['SharedRef'],
    SharedObject: class {} as unknown as ExpoGlobalShim['SharedObject'],
    NativeModule: class {} as unknown as ExpoGlobalShim['NativeModule'],
    modules: {} as ExpoGlobalShim['modules'],
} satisfies Partial<ExpoGlobalShim>;
(globalThis as typeof globalThis & { expo: ExpoGlobalShim }).expo = expoShim as ExpoGlobalShim;
process.env.EXPO_OS = 'web';

vi.mock('@/dev/reactNativeStub', async () => await import('../../../dev/reactNativeStub'));
vi.mock('@/dev/testkit/mocks/reactNative', async () => await import('../../../dev/testkit/mocks/reactNative'));
vi.mock('@/dev/testkit/mocks/router', async () => await import('../../../dev/testkit/mocks/router'));
vi.mock('@/dev/testkit/mocks/modal', async () => await import('../../../dev/testkit/mocks/modal'));
vi.mock('@/dev/testkit/mocks/text', async () => await import('../../../dev/testkit/mocks/text'));
vi.mock('@/dev/testkit/mocks/unistyles', async () => await import('../../../dev/testkit/mocks/unistyles'));
vi.mock('@/theme', async () => await import('../../../theme'));

const modalAlertAsyncSpy = vi.fn(async () => {});

installRestoreScanComputerQrViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('../../../dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alertAsync: modalAlertAsyncSpy,
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

const loginWithCredentialsSpy = vi.fn(async () => {});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        login: vi.fn(async () => {}),
        loginWithCredentials: loginWithCredentialsSpy,
        refreshFromActiveServer: vi.fn(async () => {}),
    }),
}));

vi.mock('expo-constants', () => ({
    default: { deviceName: undefined },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/server/url/serverUrlOverridePolicy', () => ({
    resolveEffectiveServerUrlOverride: () => null,
}));

vi.mock('@/sync/domains/server/url/serverUrlClassification', () => ({
    isLoopbackServerUrl: () => false,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s',
    parsePairingDeepLink: () => ({ pairId: 'pair_123', secret: 'secret_123', serverUrl: null }),
}));

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingRequest: vi.fn(async () => ({ ok: true, data: { confirmCode: '1234' } })),
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => true),
}));

// A real transferred account-link payload: 32 untagged raw key bytes.
vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => ({
        token: 'transferred-token',
        secret: new Uint8Array(32).fill(9),
    })),
}));

// A well-formed settings response whose content is plain, so no encrypted envelope exists to
// prove a family against. Other encrypted account-scoped material (machines, sessions) may still
// exist, so the receiver must refuse rather than guess a family.
const serverFetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: { t: 'plain', v: {} }, version: 1 }),
}));
vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('RestoreScanComputerQrView (unverifiable account key family)', () => {
    it('refuses to store credentials and shows an actionable error when the family cannot be proven', async () => {
        vi.resetModules();
        modalAlertAsyncSpy.mockClear();
        loginWithCredentialsSpy.mockClear();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            if (!tree) throw new Error('Expected renderer');
            expect(typeof lastScannerProps?.onScan).toBe('function');

            await act(async () => {
                await lastScannerProps.onScan('happier:///pair?v=1&pairId=pair_123&secret=secret_123');
            });

            // Visible, specific refusal — not a generic failure and not a silent spin.
            expect(modalAlertAsyncSpy).toHaveBeenCalledWith(
                'connect.accountLinkKeyFamilyUnverifiedTitle',
                'connect.accountLinkKeyFamilyUnverifiedBody',
            );
            // No credential is persisted and no authenticated writer is started.
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
