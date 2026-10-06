import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { V2SessionRecord } from '@happier-dev/protocol';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionSnapshot';

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: { onAgentRequest: vi.fn() },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const ACTIVITY_AT = 1_700_000_000_000;

function buildRow(id: string): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: ACTIVITY_AT,
        updatedAt: ACTIVITY_AT,
        meaningfulActivityAt: ACTIVITY_AT,
        active: false,
        activeAt: ACTIVITY_AT,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ path: '/repo', host: 'host' }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        lastViewedSessionSeq: 1,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingBlockedCount: 0,
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: ACTIVITY_AT,
        dataEncryptionKey: null,
        share: null,
        unreadSince: null,
    } as V2SessionRecord;
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness(): SessionListEncryption {
    return {
        decryptEncryptionKeys: vi.fn(async (values: readonly string[]) => values.map(() => null)),
        initializeSessions: vi.fn(async () => {}),
        removeSessionEncryption: vi.fn(),
        getSessionEncryption: vi.fn(() => null),
    };
}

type ApplyCall = Readonly<{
    renderables: SessionListRenderableSession[];
    options: { replace?: boolean; coversEntireList?: boolean } | undefined;
}>;

async function runSnapshot(input: Readonly<{
    cursor?: string | null;
    page: { sessions: V2SessionRecord[]; nextCursor: string | null; hasNext: boolean };
    request?: () => Promise<Response>;
    calls?: ApplyCall[];
}>): Promise<ApplyCall[]> {
    const calls: ApplyCall[] = input.calls ?? [];
    await fetchAndApplySessions({
        credentials: { token: 't', secret: 's' } as AuthCredentials,
        encryption: createEncryptionHarness(),
        sessionDataKeys: new Map<string, Uint8Array>(),
        sessionListCursor: input.cursor ?? null,
        request: input.request ?? (async () => jsonResponse(input.page)),
        applySessionListRenderables: (renderables, options) => {
            calls.push({ renderables, options });
        },
        applySessions: () => {},
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });
    return calls;
}

describe('session-list snapshot completeness', () => {
    it('reports a single exhaustive first page as covering the entire list', async () => {
        const calls = await runSnapshot({
            page: { sessions: [buildRow('s1')], nextCursor: null, hasNext: false },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].options?.replace).toBe(true);
        expect(calls[0].options?.coversEntireList).toBe(true);
    });

    it('reports an exhaustive empty first page as covering the entire list', async () => {
        const calls = await runSnapshot({
            page: { sessions: [], nextCursor: null, hasNext: false },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].renderables).toEqual([]);
        expect(calls[0].options?.coversEntireList).toBe(true);
    });

    it('does not claim completeness while the server still has a next page', async () => {
        const calls = await runSnapshot({
            page: { sessions: [buildRow('s1')], nextCursor: 'cursor_2', hasNext: true },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].options?.coversEntireList).toBe(false);
    });

    it('does not claim completeness when a next page is reported without a usable cursor', async () => {
        const calls = await runSnapshot({
            page: { sessions: [buildRow('s1')], nextCursor: null, hasNext: true },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].options?.coversEntireList).toBe(false);
    });

    it('does not claim completeness when the compatible response omits the pagination declaration', async () => {
        const calls = await runSnapshot({
            page: { sessions: [buildRow('s1')], nextCursor: null, hasNext: false },
            request: async () => jsonResponse({ sessions: [buildRow('s1')], nextCursor: 'cursor_2' }),
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].options?.coversEntireList).toBe(false);
    });

    it('does not claim completeness for a page fetched from a cursor', async () => {
        const calls = await runSnapshot({
            cursor: 'cursor_2',
            page: { sessions: [buildRow('s2')], nextCursor: null, hasNext: false },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].options?.coversEntireList).toBe(false);
    });

    it('applies nothing when the list request fails, leaving the last good list in place', async () => {
        const calls: ApplyCall[] = [];
        await expect(runSnapshot({
            calls,
            page: { sessions: [], nextCursor: null, hasNext: false },
            request: async () => {
                throw new Error('network down');
            },
        })).rejects.toThrow();
        expect(calls).toHaveLength(0);
    });
});
