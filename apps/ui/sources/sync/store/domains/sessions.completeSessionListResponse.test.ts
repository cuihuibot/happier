import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }
        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }
        delete(key: string) {
            mmkvStore.delete(key);
        }
        getAllKeys() {
            return [...mmkvStore.keys()];
        }
        clearAll() {
            mmkvStore.clear();
        }
    }
    return { MMKV };
});

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionsDomain } from './sessions';
import { clearPersistence } from '@/sync/domains/state/persistence';

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

function createHarness() {
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
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    set(domain as any);
    return { get, set, domain };
}

/** Newest-first, as the server emits the listing. */
const head = renderable('s_head', { meaningfulActivityAt: 3_000, createdAt: 3_000 });
const pagedIn = renderable('s_paged_in', { meaningfulActivityAt: 200, createdAt: 200 });
const archived = renderable('s_archived', {
    meaningfulActivityAt: 100,
    createdAt: 100,
    archivedAt: 150,
});

describe('sessions domain: complete session-list responses', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('drops unarchived rows a complete response omits', () => {
        const { get, domain } = createHarness();
        domain.replaceSessionListRenderables([head, pagedIn]);
        expect(Object.keys(get().sessionListRenderables).sort()).toEqual(['s_head', 's_paged_in']);

        domain.replaceSessionListRenderables([head], { coversEntireList: true });

        expect(Object.keys(get().sessionListRenderables)).toEqual(['s_head']);
    });

    it('keeps rows the user paged in when the response is only a page', () => {
        const { get, domain } = createHarness();
        domain.replaceSessionListRenderables([head, pagedIn]);

        domain.replaceSessionListRenderables([head], { coversEntireList: false });

        expect(Object.keys(get().sessionListRenderables).sort()).toEqual(['s_head', 's_paged_in']);
    });

    it('keeps the last good list when an incomplete response contains no rows', () => {
        const { get, domain } = createHarness();
        domain.replaceSessionListRenderables([head, pagedIn, archived]);

        domain.replaceSessionListRenderables([], { coversEntireList: false });

        expect(Object.keys(get().sessionListRenderables).sort()).toEqual(['s_archived', 's_head', 's_paged_in']);
    });

    it('keeps appended rows when a later page merges in', () => {
        const { get, domain } = createHarness();
        domain.replaceSessionListRenderables([head], { coversEntireList: false });

        domain.mergeSessionListRenderables([pagedIn]);

        expect(Object.keys(get().sessionListRenderables).sort()).toEqual(['s_head', 's_paged_in']);
    });

    it('preserves archived rows and hydrated detail state across a complete response', () => {
        const { get, set, domain } = createHarness();
        domain.replaceSessionListRenderables([head, pagedIn, archived]);
        const committedArchived = get().sessionListRenderables.s_archived;
        // Detail/transcript state the list response has no authority over.
        set((state: any) => ({
            ...state,
            sessions: { ...state.sessions, s_paged_in: { id: 's_paged_in', seq: 1 } },
            sessionMessages: { ...state.sessionMessages, s_paged_in: { messages: ['m1'] } },
        }));

        domain.replaceSessionListRenderables([head], { coversEntireList: true });

        expect(get().sessionListRenderables.s_archived).toBe(committedArchived);
        expect(get().sessionListRenderables.s_paged_in).toBeUndefined();
        expect(get().sessions.s_paged_in).toBeDefined();
        expect(get().sessionMessages.s_paged_in).toBeDefined();
    });

    it('clears the unarchived list for a complete empty response', () => {
        const { get, domain } = createHarness();
        domain.replaceSessionListRenderables([head, pagedIn, archived]);

        domain.replaceSessionListRenderables([], { coversEntireList: true });

        expect(Object.keys(get().sessionListRenderables)).toEqual(['s_archived']);
    });
});
