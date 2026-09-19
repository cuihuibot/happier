import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type {
  SessionRuntimeActivityContribution,
  SessionRuntimeActivityContributionHandle,
} from '@/session/runtimeActivity/types';

import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';

const SELECTION: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
  },
};

const OVERRIDES = { v: 1 as const, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } };

function createResumableBackend() {
  let handler: AgentMessageHandler | null = null;
  const backend: AgentBackend = {
    async startSession(): Promise<StartSessionResult> {
      return { sessionId: 'child_1' as SessionId };
    },
    async loadSessionWithReplayCapture(_id: SessionId): Promise<StartSessionResult & { replay: unknown[] }> {
      return { sessionId: 'child_1' as SessionId, replay: [] };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {},
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(next: AgentMessageHandler): void {
      handler = next;
    },
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {},
  };
  return { backend, getHandler: () => handler };
}

function createContributionHarness() {
  const reports: SessionRuntimeActivityContribution[] = [];
  return {
    reports,
    handle: {
      report: vi.fn(async (snapshot: SessionRuntimeActivityContribution) => { reports.push(snapshot); }),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies SessionRuntimeActivityContributionHandle,
  };
}

describe('ExecutionRunManager — resume rehydrates the immutable launch record', () => {
  it('retains the per-run bounded timeout after resume instead of using the manager default', async () => {
    vi.useFakeTimers();
    let prompts = 0;
    const manager = new ExecutionRunManager({
      parentProvider: 'copilot', cwd: process.cwd(), sendAcp: () => {},
      boundedTimeoutMs: 10_000,
      createBackend: () => {
        const fixture = createResumableBackend();
        return {
          ...fixture.backend,
          async sendPrompt() {
            prompts += 1;
            if (prompts > 1) await new Promise<void>(() => {});
            fixture.getHandler()?.({ type: 'model-output', fullText: '{"summary":"ready","deliverables":[]}' });
          },
        };
      },
    });
    let runId: string | undefined;
    try {
      const started = await manager.start({
        sessionId: 'parent_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded',
        ioMode: 'request_response', boundedTimeoutMs: 100,
      });
      runId = started.runId;
      await manager.waitForTerminal(runId);
      expect(manager.getPublic(runId)?.status).toBe('succeeded');
      expect(await manager.send(runId, { message: 'Continue.', resume: true })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(99);
      expect(manager.getPublic(runId)?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(2);
      expect(manager.getPublic(runId)?.status).toBe('timeout');
      expect(manager.getLatestToolResult(runId)).toMatchObject({ status: 'timeout' });
    } finally {
      if (runId) {
        await manager.stop(runId);
        await manager.waitForTerminal(runId);
      }
      vi.useRealTimers();
    }
  });

  it('completes each resumed bounded turn with a fresh structured result in the same vendor session', async () => {
    let turn = 0;
    const loaded: string[] = [];
    const manager = new ExecutionRunManager({
      parentProvider: 'copilot',
      cwd: process.cwd(),
      maxTurns: 3,
      createBackend: () => {
        const fixture = createResumableBackend();
        return {
          ...fixture.backend,
          async loadSessionWithReplayCapture(id: SessionId) {
            loaded.push(id);
            return { sessionId: id, replay: [] };
          },
          async sendPrompt() {
            turn += 1;
            fixture.getHandler()?.({ type: 'model-output', fullText: JSON.stringify({
              summary: `turn-${turn}`, deliverables: [],
            }) });
          },
        };
      },
      sendAcp: () => {},
    });
    const started = await manager.start({
      sessionId: 'parent_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
      instructions: 'Return a result.', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response',
    });
    await manager.waitForTerminal(started.runId);
    expect(manager.getLatestToolResult(started.runId)).toMatchObject({ summary: 'turn-1' });
    for (const expected of [2, 3]) {
      expect(await manager.send(started.runId, { message: 'Continue.', resume: true })).toEqual({ ok: true });
      await vi.waitFor(() => expect(manager.getPublic(started.runId)?.status).toBe('succeeded'), { timeout: 500 });
      await manager.waitForTerminal(started.runId);
      expect(manager.getLatestToolResult(started.runId)).toMatchObject({ summary: `turn-${expected}` });
      expect(manager.getStructuredMeta(started.runId)?.payload).toMatchObject({ summary: `turn-${expected}` });
      expect(manager.getPublic(started.runId)?.resumeHandle).toMatchObject({ vendorSessionId: 'child_1' });
    }
    expect(loaded).toEqual(['child_1', 'child_1']);
    expect(await manager.send(started.runId, { message: 'Over limit.', resume: true })).toMatchObject({
      ok: false, errorCode: 'execution_run_not_allowed', error: 'Turn limit exceeded',
    });
    expect(manager.getPublic(started.runId)?.status).toBe('succeeded');
    expect(await manager.ensure(started.runId, { resume: true })).toEqual({ ok: true });
    expect(await manager.send(started.runId, { message: 'Over limit after ensure.', resume: true })).toMatchObject({
      ok: false, errorCode: 'execution_run_not_allowed', error: 'Turn limit exceeded',
    });
    await manager.stop(started.runId);
    await manager.waitForTerminal(started.runId);
  });

  it('rejects a resume while the prior bounded occurrence is still disposing', async () => {
    let release!: () => void;
    const disposing = new Promise<void>((resolve) => { release = resolve; });
    const manager = new ExecutionRunManager({
      parentProvider: 'copilot', cwd: process.cwd(), sendAcp: () => {},
      createBackend: () => {
        const fixture = createResumableBackend();
        return {
          ...fixture.backend,
          async sendPrompt() {
            fixture.getHandler()?.({ type: 'model-output', fullText: '{"summary":"ready","deliverables":[]}' });
          },
          async dispose() { await disposing; },
        };
      },
    });
    const started = await manager.start({
      sessionId: 'parent_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
    });
    try {
      await vi.waitFor(() => expect(manager.getPublic(started.runId)?.status).toBe('succeeded'));
      expect(await manager.send(started.runId, { message: 'Too early.', resume: true })).toMatchObject({
        ok: false, errorCode: 'execution_run_busy',
      });
      expect(manager.getLatestToolResult(started.runId)).toMatchObject({ summary: 'ready' });
    } finally {
      release();
      await manager.waitForTerminal(started.runId);
    }
  });

  it('releases connected-service materialization when a terminal run has no resume handle', async () => {
    const cleanup = vi.fn(async () => {});
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: '/tmp/wt',
      createBackend: ({ connectedServicesCleanup }) => {
        const backend = createResumableBackend().backend;
        return {
          ...backend,
          loadSessionWithReplayCapture: undefined,
          async dispose() {
            await connectedServicesCleanup?.();
          },
        } as AgentBackend;
      },
      sendAcp: () => {},
    });

    const started = await manager.start({
      sessionId: 'parent_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'one turn',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      connectedServicesSelection: SELECTION,
      connectedServicesEnv: { CODEX_HOME: '/run/root/codex-home' },
      connectedServicesCleanup: cleanup,
    });
    await manager.waitForTerminal(started.runId);

    expect(manager.get(started.runId)?.resumeHandle).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports a resumed canonical run before backend recreation and restores terminal state on report failure', async () => {
    const contribution = createContributionHarness();
    const createBackend = vi.fn(() => createResumableBackend().backend);
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: '/tmp/wt',
      createBackend,
      sendAcp: () => {},
      runtimeActivityContributionHandle: contribution.handle,
    });
    const started = await manager.start({
      sessionId: 'parent_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
    });
    await manager.stop(started.runId);
    await manager.waitForTerminal(started.runId);
    const backendCallsBeforeResume = createBackend.mock.calls.length;
    contribution.handle.report.mockRejectedValueOnce(new Error('resume contribution rejected'));

    await expect(manager.ensure(started.runId, { resume: true })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_runtime_activity_unavailable',
      error: 'resume contribution rejected',
    });

    expect(createBackend).toHaveBeenCalledTimes(backendCallsBeforeResume);
    expect(manager.get(started.runId)?.status).toBe('cancelled');
    expect(contribution.handle.report.mock.calls.at(-2)?.[0]).toEqual({
      state: 'active', activeCount: 1,
    });
    expect(contribution.reports).toEqual([
      { state: 'active', activeCount: 1 },
      { state: 'idle', activeCount: 0 },
      { state: 'idle', activeCount: 0 },
    ]);
  });

  it('fails closed on resume when the persisted CS account cannot be re-materialized', async () => {
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: '/tmp/wt',
      createBackend: () => createResumableBackend().backend,
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
      resolveAccountSettings: async () => null,
      prepareConnectedServices: async () => {
        const { ExecutionRunConnectedServicesUnavailableError } = await import(
          '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices'
        );
        throw new ExecutionRunConnectedServicesUnavailableError({ agentId: 'codex' });
      },
    });

    const started = await manager.start({
      sessionId: 'parent_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      connectedServicesSelection: SELECTION,
      connectedServicesEnv: { CODEX_HOME: '/start/root/codex-home' },
    });

    await manager.stop(started.runId);
    await manager.waitForTerminal(started.runId);

    const resumed = await manager.send(started.runId, { message: 'continue', resume: true });
    expect(resumed.ok).toBe(false);
    expect(resumed.errorCode).toBe('execution_run_connected_services_unavailable');
  });

  it('awaits connected-service cleanup when resume backend construction throws', async () => {
    let createCalls = 0;
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cleanup = vi.fn(async () => {
      await cleanupGate;
    });
    const manager = new ExecutionRunManager({
      parentProvider: 'claude',
      cwd: '/tmp/wt',
      createBackend: () => {
        createCalls += 1;
        if (createCalls > 1) throw new Error('resume backend construction failed');
        return createResumableBackend().backend;
      },
      sendAcp: () => {},
      getNowMs: () => 1_700_000_000_000,
      resolveAccountSettings: async () => null,
      prepareConnectedServices: async () => ({
        env: { CODEX_HOME: '/resume/root/codex-home' },
        materializationKey: 'execution_run:resume',
        cleanup,
        selection: SELECTION,
        registration: {
          v: 1,
          agentId: 'codex',
          materializationKey: 'execution_run:resume',
          connectedServicesBindings: SELECTION,
          brokerSelectionIdentity: null,
          runtimeAccountIdentitySelections: [],
          sessionDirectory: '/tmp/wt',
          materializedRoot: '/resume/root',
        },
      }),
    });

    const started = await manager.start({
      sessionId: 'parent_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      connectedServicesSelection: SELECTION,
      connectedServicesEnv: { CODEX_HOME: '/start/root/codex-home' },
    });
    await manager.stop(started.runId);
    await manager.waitForTerminal(started.runId);

    let resumeSettled = false;
    const resume = manager.send(started.runId, { message: 'continue', resume: true }).then((result) => {
      resumeSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(createCalls).toBe(2));

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(resumeSettled).toBe(false);
    finishCleanup();

    const result = await resume;
    expect(result).toMatchObject({ ok: false, error: 'resume backend construction failed' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
