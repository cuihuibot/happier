import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import { AIBackendProfileSchema } from '../profiles/backendProfileSchema';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    sessionSpawnPicker: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  };
}

describe('createActionExecutor model/effort run-option parity', () => {
  it.each(['voice-profile', null])('preserves the existing voice profile meaning without native-worker resolution (%s)', async (profileId) => {
    const start = vi.fn(async () => ({ runId: 'voice-run' }));
    const executor = createActionExecutor(createDeps({ executionRunStart: start }));
    const result = await executor.execute('execution.run.start', {
      profileId, intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'streaming',
    }, { defaultSessionId: 'parent' });
    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledWith('parent', expect.objectContaining({ profileId }), undefined);
  });
  it('denies a saved worker permission above its parent without starting work', async () => {
    const profile = AIBackendProfileSchema.parse({
      id: 'worker', name: 'Worker', defaultPermissionMode: 'yolo',
      executionRunDefaults: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'reader', updatedAt: 1 } } },
      },
    });
    const start = vi.fn(async () => ({}));
    const executor = createActionExecutor(createDeps({ executionRunProfilesRead: async () => [profile], executionRunStart: start }));
    const result = await executor.execute('subagents.delegate.start', { profileId: 'worker', instructions: 'Read.' },
      { defaultSessionId: 'parent', surface: 'session_agent', callerPermissionMode: 'read-only' });
    expect(result.ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it('resolves a saved profile before defaults and checks its effective permission against the parent', async () => {
    const profile = AIBackendProfileSchema.parse({
      id: 'worker', name: 'My worker', defaultModelMode: 'explicit-model',
      defaultPermissionModeByTargetKey: { 'agent:copilot': 'read-only' },
      executionRunDefaults: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'reviewer', updatedAt: 1 } } },
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      },
    });
    const requests: unknown[] = [];
    const executor = createActionExecutor(createDeps({
      executionRunProfilesRead: async () => [profile],
      executionRunStart: async (_sessionId: string, request: unknown) => {
        requests.push(request);
        return { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' };
      },
    }));
    const result = await executor.execute('subagents.delegate.start', {
      profileId: 'my WORKER', instructions: 'Review', modelId: 'override-model',
    }, { defaultSessionId: 'parent', surface: 'session_agent', callerPermissionMode: 'read-only' });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      profileId: 'worker', modelId: 'override-model', permissionMode: 'read_only',
      backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      sessionConfigOptionOverrides: { overrides: { agent: { value: 'reviewer' } } },
    });
  });

  it('rejects a missing explicitly selected profile rather than launching generic work', async () => {
    const executionRunStart = vi.fn(async () => ({}));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunProfilesRead: async () => [],
    }));
    const result = await executor.execute('subagents.delegate.start', {
      profileId: 'missing', backendTargetKeys: ['agent:copilot'], instructions: 'Review',
    }, { defaultSessionId: 'parent' });
    expect(result.ok).toBe(false);
    expect(executionRunStart).not.toHaveBeenCalled();
  });
  it('threads modelId + configOptions(reasoning_effort) into subagents.delegate.start as canonical overrides', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'Do the thing.',
        modelId: 'gpt-5.5',
        configOptions: { reasoning_effort: 'high' },
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const [, request] = executionRunStart.mock.calls[0]!;
    expect((request as { modelId?: string }).modelId).toBe('gpt-5.5');
    const overrides = (request as { sessionConfigOptionOverrides?: { overrides: Record<string, { value: unknown }> } })
      .sessionConfigOptionOverrides;
    expect(overrides?.overrides.reasoning_effort?.value).toBe('high');
  });

  it('preserves exact nonblank opaque model, config, and value identifiers', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:cursor'],
        instructions: 'Do the thing.',
        modelId: ' model-a ',
        configOptions: { ' effort ': ' high ' },
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const [, request] = executionRunStart.mock.calls[0]!;
    expect((request as { modelId?: string }).modelId).toBe(' model-a ');
    const overrides = (request as { sessionConfigOptionOverrides?: { overrides: Record<string, { value: unknown }> } })
      .sessionConfigOptionOverrides;
    expect(overrides?.overrides[' effort ']?.value).toBe(' high ');
  });

  it('threads modelId + sessionConfigOptionOverrides into execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start',
      {
        sessionId: 's1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Do it.',
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        modelId: 'gpt-5.5',
        configOptions: { reasoning_effort: 'xhigh' },
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const [, request] = executionRunStart.mock.calls[0]!;
    expect((request as { modelId?: string }).modelId).toBe('gpt-5.5');
    const overrides = (request as { sessionConfigOptionOverrides?: { overrides: Record<string, { value: unknown }> } })
      .sessionConfigOptionOverrides;
    expect(overrides?.overrides.reasoning_effort?.value).toBe('xhigh');
    // configOptions shorthand must be merged away, not forwarded as a second vocabulary.
    expect((request as { configOptions?: unknown }).configOptions).toBeUndefined();
  });

  it('rejects conflicting configOptions vs sessionConfigOptionOverrides with typed invalid_parameters', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'Do the thing.',
        configOptions: { reasoning_effort: 'high' },
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 1,
          overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } },
        },
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('invalid_parameters');
    expect(executionRunStart).not.toHaveBeenCalled();
  });
});
