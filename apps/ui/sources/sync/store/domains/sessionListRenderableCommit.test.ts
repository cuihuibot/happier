import { describe, expect, it, vi } from 'vitest';

import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import {
    applySessionListRenderableCommitPlan,
    planSessionListRenderablePatchesCommit,
    planSessionListRenderableReplacementCommit,
    type SessionListRenderableCommitState,
} from './sessionListRenderableCommit';

vi.mock('../../domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server_active',
        serverUrl: 'https://active.example.test',
        generation: 1,
    }),
}));

function makeRenderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
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

function makeState(input: Readonly<{
    activeListViewData: SessionListViewItem[];
    targetRenderable: SessionListRenderableSession;
}>): SessionListRenderableCommitState {
    return {
        sessions: {},
        sessionListRenderables: {
            [input.targetRenderable.id]: input.targetRenderable,
        },
        sessionListViewData: input.activeListViewData,
        sessionListViewDataByServerId: {
            server_active: input.activeListViewData,
        },
        machines: {},
        machineDisplayById: {},
        settings: {
            groupInactiveSessionsByProject: false,
        },
    };
}

describe('sessionListRenderableCommit', () => {
    it('does not refresh the active cache for display-only patches scoped to a non-active uncached server', () => {
        const activeRenderable = makeRenderable('s1', { pendingCount: 0 });
        const targetRenderable = makeRenderable('s1', { pendingCount: 0 });
        const activeListViewData: SessionListViewItem[] = [{
            type: 'session',
            session: activeRenderable,
            serverId: 'server_active',
        }];
        const state = makeState({ activeListViewData, targetRenderable });
        const plan = planSessionListRenderablePatchesCommit({
            state,
            patches: [{
                sessionId: 's1',
                patch: { pendingCount: 2 },
            }],
        });

        const next = applySessionListRenderableCommitPlan({
            state,
            plan,
            targetServerId: 'server_target',
        });

        expect(next.sessionListRenderables.s1.pendingCount).toBe(2);
        expect(next.sessionListViewData).toBe(activeListViewData);
        expect(next.sessionListViewDataByServerId.server_active).toBe(activeListViewData);
        expect(next.sessionListViewDataByServerId.server_target).toBeUndefined();
    });

    it('keeps active list data stable for overlay-owned pending patches', () => {
        const renderable = makeRenderable('s1', {
            pendingCount: 0,
            pendingBlockedCount: 0,
            hasPendingUserActionRequests: false,
        });
        const activeListViewData: SessionListViewItem[] = [{
            type: 'session',
            session: renderable,
            serverId: 'server_active',
        }];
        const state = makeState({ activeListViewData, targetRenderable: renderable });
        const plan = planSessionListRenderablePatchesCommit({
            state,
            patches: [{
                sessionId: 's1',
                patch: {
                    pendingCount: 2,
                    pendingBlockedCount: 1,
                    hasPendingUserActionRequests: true,
                },
            }],
        });

        const next = applySessionListRenderableCommitPlan({
            state,
            plan,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(false);
        expect(plan.listViewRowRefreshSessionIds).toEqual([]);
        expect(next.sessionListRenderables.s1.pendingBlockedCount).toBe(1);
        expect(next.sessionListViewData).toBe(activeListViewData);
        expect(next.sessionListViewDataByServerId.server_active).toBe(activeListViewData);
    });

    it('caches rebuilt target-server data without replacing it with the active list', () => {
        const activeRenderable = makeRenderable('s1', { active: false });
        const targetRenderable = makeRenderable('s1', { active: false });
        const targetRebuiltRenderable = makeRenderable('s1', { active: true });
        const activeListViewData: SessionListViewItem[] = [{
            type: 'session',
            session: activeRenderable,
            serverId: 'server_active',
        }];
        const rebuiltTargetListViewData: SessionListViewItem[] = [{
            type: 'session',
            session: targetRebuiltRenderable,
            serverId: 'server_target',
        }];
        const state = makeState({ activeListViewData, targetRenderable });
        const plan = planSessionListRenderablePatchesCommit({
            state,
            patches: [{
                sessionId: 's1',
                patch: { active: true },
            }],
        });

        const next = applySessionListRenderableCommitPlan({
            state,
            plan,
            targetServerId: 'server_target',
            measureListRebuild: () => rebuiltTargetListViewData,
        });

        expect(plan.needsSessionListViewDataRebuild).toBe(true);
        expect(next.sessionListViewData).toBe(activeListViewData);
        expect(next.sessionListViewDataByServerId.server_active).toBe(activeListViewData);
        expect(next.sessionListViewDataByServerId.server_target).toBe(rebuiltTargetListViewData);
    });

    describe('complete session-list responses', () => {
        // Ordered newest-first, as the server emits them.
        const head = makeRenderable('s_head', { meaningfulActivityAt: 1_000, createdAt: 1_000 });
        const stale = makeRenderable('s_stale', { meaningfulActivityAt: 100, createdAt: 100 });
        const archived = makeRenderable('s_archived', {
            meaningfulActivityAt: 50,
            createdAt: 50,
            archivedAt: 60,
        });

        function makeReplacementState(
            renderables: ReadonlyArray<SessionListRenderableSession>,
        ): SessionListRenderableCommitState {
            return {
                sessions: {},
                sessionListRenderables: Object.fromEntries(renderables.map((entry) => [entry.id, entry])),
                sessionListViewData: [],
                sessionListViewDataByServerId: {},
                machines: {},
                machineDisplayById: {},
                settings: { groupInactiveSessionsByProject: false },
            };
        }

        it('evicts unarchived rows the complete response omits', () => {
            const plan = planSessionListRenderableReplacementCommit({
                state: makeReplacementState([head, stale]),
                incomingRenderables: [head],
                coversEntireList: true,
            });

            expect(plan.removedSessionIds).toEqual(['s_stale']);
            expect(plan.nextRenderables.s_head).toBeDefined();
        });

        it('keeps archived rows a complete unarchived listing never carries', () => {
            const plan = planSessionListRenderableReplacementCommit({
                state: makeReplacementState([head, stale, archived]),
                incomingRenderables: [head],
                coversEntireList: true,
            });

            expect(plan.removedSessionIds).toEqual(['s_stale']);
            expect(plan.nextRenderables.s_archived).toBe(archived);
        });

        it('keeps paged-in rows below the range an incomplete response covers', () => {
            const plan = planSessionListRenderableReplacementCommit({
                state: makeReplacementState([head, stale]),
                incomingRenderables: [head],
                coversEntireList: false,
            });

            expect(plan.removedSessionIds).toEqual([]);
            expect(plan.nextRenderables.s_stale).toBe(stale);
        });

        it('treats an absent completeness flag as the paginated response it already was', () => {
            const plan = planSessionListRenderableReplacementCommit({
                state: makeReplacementState([head, stale]),
                incomingRenderables: [head],
            });

            expect(plan.removedSessionIds).toEqual([]);
            expect(plan.nextRenderables.s_stale).toBe(stale);
        });

        it('clears every unarchived row for a complete empty response', () => {
            const plan = planSessionListRenderableReplacementCommit({
                state: makeReplacementState([head, stale, archived]),
                incomingRenderables: [],
                coversEntireList: true,
            });

            expect([...plan.removedSessionIds].sort()).toEqual(['s_head', 's_stale']);
            expect(plan.nextRenderables.s_archived).toBe(archived);
        });
    });
});
