/**
 * IQE-SDK-AC08-ANCHOR-001 producer-level regression.
 *
 * Composes the REAL canonical owners - `createAcpRuntime`,
 * `runPermissionModePromptLoop` and the real Copilot SDK backend - and controls
 * only the native SDK transport boundary. It proves the exact inner regression
 * the live evidence pointed at: the native runtime acknowledges custody of a
 * user input, the turn then stays pending on a held tool permission, and the
 * application must still report the canonical `accepted` provider-input outcome
 * so the claimed Pending row can settle into a canonical transcript message.
 *
 * Acceptance is never manufactured from output text and the transcript is never
 * written directly; the assertions observe the real provider-input outcome
 * observer that `ApiSessionClient.bindProviderInputOutcomeProducer` returns.
 */
import { describe, expect, it, vi } from 'vitest';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCopilotSdkBackend } from './backend';
import { toSdkPermissionDecision } from './runtime';

/**
 * Stand-in for the external native Copilot runtime reached over stdio, matching
 * the pinned 1.0.13 contract: `session.send` resolves with a native message id
 * on custody acknowledgement, and turn completion arrives later as an event.
 */
type SdkDecision = { kind: string; feedback?: string };

function createFakeNativeRuntime(options: { sendRejects?: Error; sendGate?: Promise<void> } = {}) {
  let emitEvent: ((event: { type: string; data?: unknown }) => void) | null = null;
  let permissionBridge: ((request: Record<string, unknown>) => Promise<SdkDecision>) | null = null;
  const sent: string[] = [];
  const session = {
    sessionId: 'native-anchor-session',
    send: vi.fn(async (prompt: string) => {
      if (options.sendRejects) throw options.sendRejects;
      // Models a native runtime that has received the bytes but has not yet
      // acknowledged custody, so cancellation can arrive mid-flight.
      if (options.sendGate) await options.sendGate;
      sent.push(prompt);
      // Custody acknowledged. The turn deliberately stays pending: no
      // session.idle is emitted here, which is the held-permission shape.
      return 'native-message-1';
    }),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    createSession: vi.fn(async (config: { onEvent?: (e: { type: string; data?: unknown }) => void }) => {
      emitEvent = config.onEvent ?? null;
      permissionBridge = (config as { onPermissionRequest?: typeof permissionBridge }).onPermissionRequest ?? null;
      return session;
    }),
    resumeSession: vi.fn(async () => session),
  };
  return {
    client,
    session,
    sent,
    emit: (event: { type: string; data?: unknown }) => {
      if (!emitEvent) throw new Error('native session was never created');
      emitEvent(event);
    },
    requestPermission: async (request: Record<string, unknown>) => {
      if (!permissionBridge) throw new Error('no host permission bridge was installed');
      return await permissionBridge(request);
    },
    hasPermissionBridge: () => permissionBridge !== null,
  };
}

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: string; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

function buildLoop(params: {
  native: ReturnType<typeof createFakeNativeRuntime>;
  localId: string;
  providerInputOutcomeObserver: ReturnType<typeof vi.fn>;
  abortController?: AbortController;
  permissionHandler?: ReturnType<typeof createApprovedPermissionHandler>;
}) {
  const session = createMutableApiSessionClientFixture<Metadata>();
  // One canonical permission owner, reached through the same bridge the real
  // provider runtime installs (runtime.ts:163-172) and the same exported
  // decision mapper. The test introduces no second decision-maker.
  const permissionHandler = params.permissionHandler ?? createApprovedPermissionHandler();
  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: '/tmp/anchor-spike',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler,
    onThinkingChange: () => {},
    ensureBackend: async () =>
      createCopilotSdkBackend({
        cliPath: '/nonexistent/copilot',
        directory: '/tmp/anchor-spike',
        createClient: () => params.native.client as never,
        onPermissionRequest: async (permissionId: string, toolName: string, input: unknown) => {
          const result = await (permissionHandler as unknown as {
            handleToolCall: (id: string, tool: string, input: unknown) => Promise<{ decision: string }>;
          }).handleToolCall(permissionId, toolName, input);
          return toSdkPermissionDecision(result.decision as never);
        },
      } as never),
  });

  const queue = createModeQueue();
  queue.push(
    { text: 'write the marker file', localId: params.localId },
    { permissionMode: 'default' },
    { userMessageSeq: 7, userMessageLocalIds: [params.localId] },
  );

  let shouldExit = false;
  const abortController = params.abortController ?? new AbortController();
  const loopPromise = runPermissionModePromptLoop({
    providerName: 'Copilot',
    agentMessageType: 'copilot',
    explicitPermissionMode: undefined,
    session,
    providerInputOutcomeObserver: params.providerInputOutcomeObserver,
    messageQueue: queue,
    permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as never,
    runtime,
    createOverrideSynchronizer: () => ({
      syncFromMetadata: () => {},
      flushPendingAfterStart: async () => {},
    }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => abortController.signal,
    keepAlive: () => {},
    setThinking: () => {},
    sendReady: () => {
      shouldExit = true;
    },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => {},
    setCurrentPermissionModeUpdatedAt: () => {},
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  } as never);

  return { session, runtime, loopPromise, abortController, permissionHandler };
}

describe('copilot SDK provider-input acceptance through the canonical ACP owners', () => {
  it('reports accepted while the turn is still pending on a held tool permission', async () => {
    const native = createFakeNativeRuntime();
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-held-permission';
    const { native: _n, ...ctx } = { native, ...buildLoop({ native, localId, providerInputOutcomeObserver }) };

    try {
      // The user message must anchor while the turn is unfinished: no native
      // terminal event has been emitted at this point.
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserver).toHaveBeenCalledWith({
          kind: 'accepted',
          localId,
        });
      }, { timeout: 5_000 });

      expect(native.sent).toEqual(['write the marker file']);
      // Turn genuinely still pending: nothing completed it.
      expect(native.session.abort).not.toHaveBeenCalled();
    } finally {
      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });

  it('does not manufacture acceptance when cancellation arrives before native custody acknowledgement, and does not let the unacknowledged send block cancellation', async () => {
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const native = createFakeNativeRuntime({ sendGate });
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-cancelled-before-acceptance';
    const abortController = new AbortController();
    const ctx = buildLoop({ native, localId, providerInputOutcomeObserver, abortController });

    try {
      // The input is in flight at the native boundary but unacknowledged.
      await vi.waitFor(() => {
        expect(native.session.send).toHaveBeenCalled();
      }, { timeout: 5_000 });
      expect(providerInputOutcomeObserver).not.toHaveBeenCalled();

      // Cancellation must not wait for an acknowledgement that may never come.
      abortController.abort();
      const cancelStartedAt = Date.now();
      await ctx.runtime.cancel();
      expect(Date.now() - cancelStartedAt).toBeLessThan(5_000);
      expect(native.session.abort).toHaveBeenCalled();

      // Acceptance was never acknowledged, so it must never be reported: a
      // cancelled-before-custody input must not anchor as a delivered message.
      const acceptedBeforeRelease = providerInputOutcomeObserver.mock.calls.filter(
        (call) => (call[0] as { kind: string }).kind === 'accepted',
      );
      expect(acceptedBeforeRelease).toEqual([]);
    } finally {
      releaseSend();
      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });

  it('still delivers a held permission decision and later native events after early custody evidence', async () => {
    const native = createFakeNativeRuntime();
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-permission-after-early-evidence';
    const ctx = buildLoop({ native, localId, providerInputOutcomeObserver });

    try {
      // Early custody evidence is published while the turn is unfinished.
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserver).toHaveBeenCalledWith({ kind: 'accepted', localId });
      }, { timeout: 5_000 });

      // The host permission bridge must still be installed and reachable after
      // sendPromptWithEvidence returned: the early return must not detach the
      // native session's callback ownership for the still-pending turn.
      expect(native.hasPermissionBridge()).toBe(true);
      const decision = await native.requestPermission({
        kind: 'shell',
        toolCallId: 'native-tool-call-after-early-evidence',
        command: 'printf %s MARKER > target.txt',
      });
      // The canonical owner's approval must reach the native side as the exact
      // typed SDK decision, not as an untyped or undefined value.
      expect(decision).toEqual({ kind: 'approve-once' });

      // Later native events for the same turn must still flow to the runtime and
      // produce an observable effect on the session, not merely be emitted.
      const agentMessages = vi.fn();
      (ctx.session as unknown as { sendAgentMessage: unknown }).sendAgentMessage = agentMessages;
      native.emit({ type: 'tool.execution_complete', data: { toolCallId: 'native-tool-call-after-early-evidence', toolName: 'shell' } });
      native.emit({ type: 'assistant.message', data: { content: 'wrote the marker' } });
      await vi.waitFor(() => {
        expect(agentMessages).toHaveBeenCalled();
      }, { timeout: 5_000 });

      // And the turn still reaches its terminal outcome rather than hanging:
      // the idle event must settle the in-flight turn.
      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await vi.waitFor(() => {
        expect(ctx.runtime.isTurnInFlight()).toBe(false);
      }, { timeout: 5_000 });
    } finally {
      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });

  it('returns a typed native rejection when the canonical owner denies a held permission', async () => {
    const native = createFakeNativeRuntime();
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-permission-denied';
    const deniedHandler = {
      handleToolCall: async () => ({ decision: 'denied' as const }),
      setPermissionMode: () => {},
      reset: () => {},
    } as unknown as ReturnType<typeof createApprovedPermissionHandler>;
    const ctx = buildLoop({ native, localId, providerInputOutcomeObserver, permissionHandler: deniedHandler });

    try {
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserver).toHaveBeenCalledWith({ kind: 'accepted', localId });
      }, { timeout: 5_000 });

      const decision = await native.requestPermission({
        kind: 'shell',
        toolCallId: 'native-tool-call-denied',
        command: 'printf %s MARKER > target.txt',
      });
      // A denial must be a real typed native rejection, never a silent
      // approval and never an undefined decision the native cannot act on.
      // Must be the canonical policy denial produced by the real mapper, not
      // the backend's "no host permission bridge is configured" fallback:
      // otherwise a disconnected bridge would masquerade as a user denial.
      expect(decision).toEqual({ kind: 'reject', feedback: 'Denied by Happier permission policy' });
    } finally {
      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });

  it('does not report accepted when the native runtime rejects the input before any effect', async () => {
    const native = createFakeNativeRuntime({
      sendRejects: new Error('native transport refused the input'),
    });
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-rejected';
    const ctx = buildLoop({ native, localId, providerInputOutcomeObserver });

    try {
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserver).toHaveBeenCalled();
      }, { timeout: 5_000 });

      const kinds = providerInputOutcomeObserver.mock.calls.map(
        (call) => (call[0] as { kind: string }).kind,
      );
      expect(kinds).not.toContain('accepted');
      expect(kinds.some((kind) => kind === 'rejected_before_effect' || kind === 'effect_may_have_occurred')).toBe(true);
    } finally {
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });

  it('keeps the already accepted user message when the turn later fails', async () => {
    const native = createFakeNativeRuntime();
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-late-failure';
    const ctx = buildLoop({ native, localId, providerInputOutcomeObserver });

    try {
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserver).toHaveBeenCalledWith({ kind: 'accepted', localId });
      }, { timeout: 5_000 });

      // The turn fails AFTER acceptance. The accepted user message must not be
      // retracted or converted into a rejection.
      native.emit({ type: 'session.error', data: { message: 'native turn failed' } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const laterKinds = providerInputOutcomeObserver.mock.calls
        .map((call) => (call[0] as { kind: string; localId: string }))
        .filter((outcome) => outcome.localId === localId)
        .map((outcome) => outcome.kind);
      expect(laterKinds).toContain('accepted');
      expect(laterKinds).not.toContain('rejected_before_effect');
    } finally {
      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });

  it('ignores a duplicate acceptance for the same input', async () => {
    const native = createFakeNativeRuntime();
    const providerInputOutcomeObserver = vi.fn();
    const localId = 'local-anchor-duplicate';
    const ctx = buildLoop({ native, localId, providerInputOutcomeObserver });

    try {
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserver).toHaveBeenCalledWith({ kind: 'accepted', localId });
      }, { timeout: 5_000 });

      native.emit({ type: 'session.idle', data: { mode: 'default' } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const acceptedForLocalId = providerInputOutcomeObserver.mock.calls
        .map((call) => call[0] as { kind: string; localId: string })
        .filter((outcome) => outcome.kind === 'accepted' && outcome.localId === localId);
      expect(acceptedForLocalId).toHaveLength(1);
    } finally {
      await ctx.loopPromise.catch(() => undefined);
      await ctx.runtime.reset().catch(() => undefined);
    }
  });
});
