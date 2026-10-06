import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installPersistenceModuleMock } from '@/dev/testkit';
import { purchasesDefaults } from '@/sync/domains/purchases/purchases';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { WARM_CACHE_STORAGE_ID } from '../../domains/state/warmCachePersistence';

/**
 * The relay the list data actually came from, and the relay the user just selected.
 * Selecting a relay flips the active-server snapshot before the sync runtime resets the
 * session scope, so any save taken in that window must still belong to the old relay.
 */
const ACCOUNT_A = 'account_a';
const ACCOUNT_B = 'account_b';
const SERVER_A = 'server_a';
const SERVER_B = 'server_b';

function warmCacheKey(serverId: string, accountId: string): string {
    return `session-list-warm-cache-v1:${serverId}:${accountId}`;
}

const mmkv = vi.hoisted(() => {
    const storesById = new Map<string, Map<string, string>>();
    function mapFor(byId: Map<string, Map<string, string>>, id: string): Map<string, string> {
        const existing = byId.get(id);
        if (existing) return existing;
        const created = new Map<string, string>();
        byId.set(id, created);
        return created;
    }
    return {
        storeFor: (id: string) => mapFor(storesById, id),
        reset: () => storesById.clear(),
    };
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        private readonly instanceId: string;

        constructor(config?: { id?: string }) {
            this.instanceId = config?.id ?? 'mmkv.default';
        }

        getString(key: string) {
            return mmkv.storeFor(this.instanceId).get(key);
        }

        set(key: string, value: string) {
            mmkv.storeFor(this.instanceId).set(key, value);
        }

        delete(key: string) {
            mmkv.storeFor(this.instanceId).delete(key);
        }

        getAllKeys() {
            return [...mmkv.storeFor(this.instanceId).keys()];
        }

        clearAll() {
            mmkv.storeFor(this.instanceId).clear();
        }
    }

    return { MMKV };
});

const storageStateRef = vi.hoisted(() => ({ current: null as any }));
const activeServerRef = vi.hoisted(() => ({ current: 'server_a' }));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    mmkv.reset();
    storageStateRef.current = null;
    activeServerRef.current = SERVER_A;
});

function mockSessionBoundaries(): void {
    vi.doMock('../../domains/state/persistence', installPersistenceModuleMock({
        loadProfile: vi.fn(() => ({ ...profileDefaults, id: ACCOUNT_A })),
        saveProfile: vi.fn(),
        loadSessionDrafts: vi.fn(() => ({})),
        loadSessionLastViewed: vi.fn(() => ({})),
        loadSessionModelModeUpdatedAts: vi.fn(() => ({})),
        loadSessionModelModes: vi.fn(() => ({})),
        loadSessionPermissionModeUpdatedAts: vi.fn(() => ({})),
        loadSessionPermissionModes: vi.fn(() => ({})),
        loadSessionActionDrafts: vi.fn(() => ({})),
        loadSessionReviewCommentsDrafts: vi.fn(() => ({})),
        loadWorkspaceReviewCommentsDrafts: vi.fn(() => ({})),
        saveSessionDrafts: vi.fn(),
        saveSessionLastViewed: vi.fn(),
        loadSettings: vi.fn(() => ({ settings: { preferredLanguage: 'en' }, version: null })),
        loadLocalSettings: vi.fn(() => ({ ...localSettingsDefaults })),
        loadPurchases: vi.fn(() => ({ ...purchasesDefaults })),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        saveLocalSettings: vi.fn(),
        savePurchases: vi.fn(),
        saveSettings: vi.fn(),
    }));
    vi.doMock('../../domains/server/serverRuntime', () => ({
        // Relay selection is mutable and flips ahead of the session-scope reset.
        getActiveServerSnapshot: () => ({ serverId: activeServerRef.current, serverUrl: 'https://example.test' }),
        subscribeActiveServer: () => () => undefined,
    }));
    vi.doMock('@/sync/domains/models/modelOptions', () => ({
        isModelSelectableForSession: vi.fn(() => true),
    }));
    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: [],
        DEFAULT_AGENT_ID: 'openai',
        resolveAgentIdFromFlavor: vi.fn(() => null),
    }));
    vi.doMock('../../domains/state/storage', async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageStateRef.current,
                getInitialState: () => storageStateRef.current,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        } as any);
    });
}

function createHarness(createSessionsDomain: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        // The profile lags a scope change: it is reset and refetched after the switch.
        profile: { id: ACCOUNT_A },
        settings: { groupInactiveSessionsByProject: false },
    };
    storageStateRef.current = state;

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
        storageStateRef.current = state;
    };

    return { domain: createSessionsDomain({ get, set } as any), get };
}

function renderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        meaningfulActivityAt: 1_000,
        active: false,
        activeAt: 1_000,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

function cachedSessionIds(serverId: string, accountId: string): string[] {
    const raw = mmkv.storeFor(WARM_CACHE_STORAGE_ID).get(warmCacheKey(serverId, accountId));
    if (!raw) return [];
    return Object.keys(JSON.parse(raw)).sort();
}

async function setupDomain() {
    mockSessionBoundaries();
    const { prepareWarmCacheEncryptionKey } = await import('../../domains/state/warmCacheEncryptionKey');
    await prepareWarmCacheEncryptionKey();
    const { createSessionsDomain } = await import('./sessions');
    return createHarness(createSessionsDomain);
}

const scopeA: ServerAccountScope = { serverId: SERVER_A, accountId: ACCOUNT_A };

describe('sessions domain: warm-cache ownership', () => {
    it('writes an immediate save to the scope the rows came from, not the newly selected relay', async () => {
        const { domain } = await setupDomain();
        domain.activateSessionLocalStateScope(scopeA);

        // The user picks the other relay: selection flips first, the session scope has not reset yet.
        activeServerRef.current = SERVER_B;
        domain.replaceSessionListRenderables([renderable('s_a1'), renderable('s_a2')]);

        expect(cachedSessionIds(SERVER_A, ACCOUNT_A)).toEqual(['s_a1', 's_a2']);
        expect(cachedSessionIds(SERVER_B, ACCOUNT_A)).toEqual([]);
    });

    it('flushes a deferred save into the scope the rows came from after the selection flipped', async () => {
        const { domain } = await setupDomain();
        domain.activateSessionLocalStateScope(scopeA);
        domain.replaceSessionListRenderables([renderable('s_a1', { active: true })]);
        expect(cachedSessionIds(SERVER_A, ACCOUNT_A)).toEqual(['s_a1']);

        vi.useFakeTimers();
        activeServerRef.current = SERVER_B;
        // A progress-only change defers its save behind the warm-cache debounce.
        domain.replaceSessionListRenderables([
            renderable('s_a1', { active: true, seq: 7, updatedAt: 2_000, meaningfulActivityAt: 2_000 }),
        ]);
        vi.advanceTimersByTime(5_000);

        expect(cachedSessionIds(SERVER_B, ACCOUNT_A)).toEqual([]);
        const persisted = JSON.parse(mmkv.storeFor(WARM_CACHE_STORAGE_ID).get(warmCacheKey(SERVER_A, ACCOUNT_A))!);
        expect(persisted.s_a1.meaningfulActivityAt).toBe(2_000);
    });

    it('keeps each account isolated when the account scope changes on the same relay', async () => {
        const { domain } = await setupDomain();
        domain.activateSessionLocalStateScope(scopeA);
        domain.replaceSessionListRenderables([renderable('s_a1')]);

        domain.activateSessionLocalStateScope({ serverId: SERVER_A, accountId: ACCOUNT_B });
        domain.replaceSessionListRenderables([renderable('s_b1')]);

        expect(cachedSessionIds(SERVER_A, ACCOUNT_A)).toEqual(['s_a1']);
        expect(cachedSessionIds(SERVER_A, ACCOUNT_B)).toEqual(['s_b1']);
    });

    it('ignores a stale process-global account scope when keying the save', async () => {
        const { domain } = await setupDomain();
        const { setWarmCacheAccountScope, clearWarmCacheAccountScope } = await import('../../domains/state/warmCachePersistence');
        setWarmCacheAccountScope('account_stale');
        try {
            domain.activateSessionLocalStateScope(scopeA);
            domain.replaceSessionListRenderables([renderable('s_a1')]);

            expect(cachedSessionIds(SERVER_A, ACCOUNT_A)).toEqual(['s_a1']);
            expect(cachedSessionIds(SERVER_A, 'account_stale')).toEqual([]);
        } finally {
            clearWarmCacheAccountScope();
        }
    });

    it('does not persist list rows while no session scope owns them', async () => {
        const { domain } = await setupDomain();

        domain.replaceSessionListRenderables([renderable('s_orphan')]);

        expect(mmkv.storeFor(WARM_CACHE_STORAGE_ID).size).toBe(0);
    });
});
