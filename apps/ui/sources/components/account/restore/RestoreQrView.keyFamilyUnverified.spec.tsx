import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native-reanimated', () => ({}));
vi.mock('@/dev/reactNativeStub', async () => await import('../../../dev/reactNativeStub'));
vi.mock('@/theme', async () => await import('../../../theme'));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('../../../dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

const routerBackSpy = vi.fn();
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('../../../dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { back: routerBackSpy } }).module;
});

const modalAlertSpy = vi.fn();
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('../../../dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('../../../dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../../../dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                overlay: {
                    scrim: 'rgba(0,0,0,0.3)',
                    scrimStrong: 'rgba(0,0,0,0.55)',
                    text: '#fff',
                    textSecondary: 'rgba(255,255,255,0.85)',
                },
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/buttons/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

const loginWithCredentialsSpy = vi.fn(async () => {});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        login: vi.fn(async () => {}),
        loginWithCredentials: loginWithCredentialsSpy,
        refreshFromActiveServer: vi.fn(async () => {}),
    }),
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
// prove a family against and the transfer must be refused rather than resolved to a default.
vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { t: 'plain', v: {} }, version: 1 }),
    })),
}));

describe('RestoreQrView (unverifiable account key family)', () => {
    it('refuses to store credentials and shows an actionable error when the family cannot be proven', async () => {
        modalAlertSpy.mockClear();
        loginWithCredentialsSpy.mockClear();
        routerBackSpy.mockClear();

        const { RestoreQrView } = await import('./RestoreQrView');

        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreQrView />);
            });
            await act(async () => {
                await Promise.resolve();
            });

            // Visible, specific refusal rather than a generic failure or a silent spin.
            expect(modalAlertSpy).toHaveBeenCalledWith(
                'connect.accountLinkKeyFamilyUnverifiedTitle',
                'connect.accountLinkKeyFamilyUnverifiedBody',
            );
            // No credential is persisted, no authenticated writer is started, no navigation onward.
            expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
            expect(routerBackSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
