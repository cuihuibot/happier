import { describe, expect, it, vi } from 'vitest';

/**
 * S1/S2 spike: the SDK runtime is selected only by explicit experiment opt-in.
 *
 * ACP remains the default for Copilot and for every legacy session. These tests
 * pin the selection contract and the `RuntimeForLoop` shape the standard agent
 * loop requires, so an SDK runtime can never silently replace ACP.
 */
describe('copilot/sdk/runtimeSelection', () => {
  it('defaults to the ACP runtime when the experiment is not selected', async () => {
    const mod = await import('./runtimeSelection');

    expect(mod.resolveCopilotRuntimeKind({})).toBe('acp');
    expect(mod.resolveCopilotRuntimeKind({ HAPPIER_COPILOT_SDK_EXPERIMENT: '' })).toBe('acp');
    expect(mod.resolveCopilotRuntimeKind({ HAPPIER_COPILOT_SDK_EXPERIMENT: '0' })).toBe('acp');
    expect(mod.resolveCopilotRuntimeKind({ HAPPIER_COPILOT_SDK_EXPERIMENT: 'false' })).toBe('acp');
  });

  it('selects the SDK runtime only on an explicit opt-in value for a created session', async () => {
    const mod = await import('./runtimeSelection');

    // The opt-in flag is necessary but not sufficient: the server must also have
    // authoritatively reported this launch as a newly created session.
    const created = { sessionLaunchOrigin: 'created' as const };
    expect(mod.resolveCopilotRuntimeKind({ HAPPIER_COPILOT_SDK_EXPERIMENT: '1' }, created)).toBe('sdk');
    expect(mod.resolveCopilotRuntimeKind({ HAPPIER_COPILOT_SDK_EXPERIMENT: 'true' }, created)).toBe('sdk');

    // Flag alone, with no authoritative origin, must stay on ACP.
    expect(mod.resolveCopilotRuntimeKind({ HAPPIER_COPILOT_SDK_EXPERIMENT: '1' })).toBe('acp');
  });

  it('keeps an existing ACP session on ACP even when the experiment is enabled', async () => {
    const mod = await import('./runtimeSelection');

    // Backend affinity: a session already started under ACP must never be
    // resumed through the SDK runtime, which would silently change its
    // persistence and event provenance.
    expect(
      mod.resolveCopilotRuntimeKind(
        { HAPPIER_COPILOT_SDK_EXPERIMENT: '1' },
        { existingBackendAffinity: 'acp' },
      ),
    ).toBe('acp');

    expect(
      mod.resolveCopilotRuntimeKind(
        { HAPPIER_COPILOT_SDK_EXPERIMENT: '1' },
        { existingBackendAffinity: 'sdk' },
      ),
    ).toBe('sdk');
  });

  it('never falls back to ACP when the SDK runtime was explicitly selected', async () => {
    const mod = await import('./runtimeSelection');

    // A failed SDK start must surface as a visible error, not a silent ACP
    // replay under a different backend.
    expect(() => mod.assertNoSilentRuntimeFallback({ selected: 'sdk', actual: 'acp' })).toThrow(
      /fallback/i,
    );

    expect(() =>
      mod.assertNoSilentRuntimeFallback({ selected: 'sdk', actual: 'sdk' }),
    ).not.toThrow();
  });
});

describe('copilot/sdk/runtime', () => {
  it('satisfies the RuntimeForLoop members the standard agent loop invokes', async () => {
    const mod = await import('./runtime');

    const runtime = mod.createCopilotSdkRuntime({
      directory: '/tmp/spike',
      // The real ApiSessionClient always exposes the durable metadata the
      // provider reads to detect an existing SDK binding; an incomplete fixture
      // here previously hid that read from these tests.
      session: { sessionId: 'spike-session', getMetadataSnapshot: () => null } as never,
      messageBuffer: { addMessage: vi.fn() } as never,
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() } as never,
      onThinkingChange: vi.fn(),
      providerInputConsumer: { drainPending: vi.fn() } as never,
      cliPath: '/nonexistent/copilot',
    });

    for (const member of [
      'beginTurn',
      'startOrLoad',
      'sendPrompt',
      'flushTurn',
      'reset',
      'getSessionId',
      'cancel',
      'setSessionMode',
      'setSessionConfigOption',
      'setSessionModel',
    ]) {
      expect(typeof runtime[member as keyof typeof runtime], `missing ${member}`).toBe('function');
    }

    // No session exists before startOrLoad; the loop relies on null here.
    expect(runtime.getSessionId()).toBeNull();
  });

  it('delegates transcript, completion and permission ownership to the canonical runtime', async () => {
    const mod = await import('./runtime');

    const runtime = mod.createCopilotSdkRuntime({
      directory: '/tmp/spike',
      session: { sessionId: 'spike-session', getMetadataSnapshot: () => null } as never,
      messageBuffer: { addMessage: vi.fn() } as never,
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() } as never,
      onThinkingChange: vi.fn(),
      providerInputConsumer: { drainPending: vi.fn() } as never,
      cliPath: '/nonexistent/copilot',
    });

    // The SDK runtime must not expose a private event projection or its own
    // completion signal: `createAcpRuntime` owns transcript persistence and
    // emits `task_complete`. A local projector here would be a second owner.
    expect((runtime as Record<string, unknown>).projectSessionEvent).toBeUndefined();
    expect((runtime as Record<string, unknown>).emitTaskComplete).toBeUndefined();
  });

  it('maps a denied permission decision onto the pinned SDK reject shape', async () => {
    const mod = await import('./runtime');

    // The pinned union has no "deny" member; host refusal is "reject".
    expect(mod.toSdkPermissionDecision('denied')).toEqual({
      kind: 'reject',
      feedback: 'Denied by Happier permission policy',
    });

    expect(mod.toSdkPermissionDecision('abort')).toEqual({
      kind: 'reject',
      feedback: 'Aborted by Happier permission policy',
    });

    // The pinned union has no `deny`; refusals must be `reject`.
    expect(mod.toSdkPermissionDecision('approved')).toEqual({ kind: 'approve-once' });
    // Session/permanent approvals narrow conservatively, never broaden.
    expect(mod.toSdkPermissionDecision('approved_for_session')).toEqual({ kind: 'approve-once' });
  });

  it('describes each pinned permission-request variant instead of falling back to "unknown"', async () => {
    const mod = await import('./runtime');

    // The pinned `PermissionRequest` is a `kind`-discriminated union; it carries
    // no flat `toolName`/`input`. A live run surfaced tool:"unknown" arguments:{}
    // because the host read fields that do not exist on any variant.
    const shell = mod.describeSdkPermissionRequest({
      kind: 'shell',
      fullCommandText: 'echo hi > /tmp/scratch.txt',
      intention: 'write a scratch marker',
      toolCallId: 'call-1',
    } as never);
    expect(shell.nativeToolCallId).toBe('call-1');
    expect(shell.toolName).toBe('shell');
    expect(shell.toolName).not.toBe('unknown');
    expect(shell.input).toMatchObject({
      fullCommandText: 'echo hi > /tmp/scratch.txt',
      intention: 'write a scratch marker',
    });

    const write = mod.describeSdkPermissionRequest({
      kind: 'write',
      fileName: '/tmp/scratch/denied.txt',
      toolCallId: 'call-2',
    } as never);
    expect(write.toolName).toBe('write');
    expect(write.input).toMatchObject({ fileName: '/tmp/scratch/denied.txt' });

    // MCP is the only variant with a real `toolName`; it must win over the kind.
    const mcp = mod.describeSdkPermissionRequest({
      kind: 'mcp',
      toolName: 'marker_tool',
      args: { marker: 'x' },
      toolCallId: 'call-3',
    } as never);
    expect(mcp.toolName).toBe('marker_tool');
    expect(mcp.input).toMatchObject({ args: { marker: 'x' } });

    // An unrecognised future variant still reports its kind, never "unknown",
    // and never an empty argument bag that hides the request from the user.
    const future = mod.describeSdkPermissionRequest({ kind: 'factory' } as never);
    expect(future.toolName).toBe('factory');
    expect(future.input).toMatchObject({ kind: 'factory' });

    // Only a genuinely kind-less payload may degrade, and even then it reports
    // no native id so the caller must mint a distinct one rather than reuse a
    // shared constant.
    const degenerate = mod.describeSdkPermissionRequest({} as never);
    expect(degenerate.toolName).toBe('unknown');
    expect(degenerate.nativeToolCallId).toBeNull();
  });
});

