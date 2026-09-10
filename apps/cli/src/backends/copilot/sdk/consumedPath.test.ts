/**
 * Consumed-path regression tests for the Copilot SDK spike vertical.
 *
 * These reproduce the eight defects an independent reviewer confirmed against
 * the previous candidate (D1-D8). Every assertion is made through the REAL
 * selection factory and the REAL canonical `createAcpRuntime` owner, because
 * the previous author suite passed while the composed path was broken: it used
 * an external-owner test runtime that cannot exercise factory persistence
 * affinity, and asserted projection helpers rather than the canonical sink.
 *
 * The only mocked boundary is the pinned `@github/copilot-sdk` transport, which
 * is a genuine external process adapter. Real permission coordination, real
 * transcript publication and real metadata persistence run underneath.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isAbortLikeError } from '@/agent/executionRuns/runtime/turnDelivery';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { Metadata } from '@/api/types';
import { createCopilotRuntime } from '@/backends/copilot/runtimeFactory';
import { createCopilotSdkBackend } from '@/backends/copilot/sdk/backend';
import { createSpikeScratchDir } from '@/backends/copilot/sdk/spikeScratch';
import { CopilotPermissionHandler } from '@/backends/copilot/utils/permissionHandler';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

const wire = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  send: vi.fn(),
  abort: vi.fn(),
  disconnect: vi.fn(),
  stop: vi.fn(),
  create: vi.fn(),
  resume: vi.fn(),
  connection: vi.fn(),
}));

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: { forStdio: wire.connection },
  CopilotClient: class {
    start = vi.fn(async () => {});
    stop = wire.stop;
    createSession = wire.create;
    resumeSession = wire.resume;
  },
}));

const NATIVE_SESSION_ID = 'spike-native-session';
const nativeSession = () => ({
  sessionId: NATIVE_SESSION_ID,
  send: wire.send,
  abort: wire.abort,
  disconnect: wire.disconnect,
});

function emit(type: string, data: Record<string, unknown> = {}): void {
  const onEvent = wire.config?.onEvent;
  if (typeof onEvent !== 'function') throw new Error('native transport is not open');
  (onEvent as (event: { type: string; data: Record<string, unknown> }) => void)({ type, data });
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => Promise<void>> = [];

const inertInputConsumer: SessionProviderInputConsumer<unknown, unknown> = {
  waitForNextInput: async () => null,
  runProviderInputDispatch: async ({ dispatch }) => ({
    status: 'dispatched',
    value: await dispatch(),
  }),
  closeProviderInputAdmissionAndWaitForDispatches: async () => {},
  drainPending: async () => ({ materialized: 0, stoppedReason: 'no_pending' }),
  pumpPendingWhileActive: async () => {},
};

function composition(
  metadata: Metadata = createTestMetadata(),
  env: NodeJS.ProcessEnv = {},
  sessionLaunchOrigin: 'created' | 'existing' | 'unknown' = 'created',
) {
  const sink = vi.fn();
  const committed = vi.fn(async () => {});
  const session = createMutableApiSessionClientFixture({
    metadata,
    overrides: { sendAgentMessage: sink, sendAgentMessageCommitted: committed },
  });
  const params = {
    directory: '/spike/synthetic-workdir',
    machineId: 'spike-machine',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: vi.fn(),
    providerInputConsumer: inertInputConsumer,
    // Supplied by the common session initializer from the server's create-or-load
    // response; the SDK is unreachable without an authoritative 'created'.
    sessionLaunchOrigin,
    processEnv: {
      HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
      HAPPIER_COPILOT_SDK_CLI_PATH: '/spike/never-launch',
      ...env,
    },
  };
  const runtime = createCopilotRuntime(params as Parameters<typeof createCopilotRuntime>[0]);
  cleanups.push(() => runtime.reset());
  return { runtime, params, session, sink, committed };
}

async function completedTurn(runtime: ReturnType<typeof createCopilotRuntime>): Promise<void> {
  runtime.beginTurn();
  await runtime.sendPrompt('SPIKE-SYNTHETIC-MARKER');
  await runtime.flushTurn();
  await tick();
}

function backend(overrides: Partial<Parameters<typeof createCopilotSdkBackend>[0]> = {}) {
  const client = {
    start: vi.fn(async () => {}),
    stop: wire.stop,
    createSession: wire.create,
    resumeSession: wire.resume,
  };
  const value = createCopilotSdkBackend({
    cliPath: '/spike/never-launch',
    directory: '/spike/synthetic-workdir',
    createClient: () => client as never,
    ...overrides,
  });
  cleanups.push(async () => {
    await value.dispose().catch(() => {});
  });
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  wire.config = null;
  wire.send.mockImplementation(async () => {
    emit('assistant.message', { content: 'SPIKE-SYNTHETIC-MARKER' });
    emit('session.idle', { mode: 'interactive' });
  });
  wire.abort.mockImplementation(async () => {});
  wire.disconnect.mockImplementation(async () => {});
  wire.stop.mockImplementation(async () => []);
  wire.create.mockImplementation(async (config: Record<string, unknown>) => {
    wire.config = config;
    return nativeSession();
  });
  wire.resume.mockImplementation(async (id: string, config: Record<string, unknown>) => {
    wire.config = config;
    return { ...nativeSession(), sessionId: id };
  });
});

afterEach(async () => {
  wire.disconnect.mockImplementation(async () => {});
  wire.stop.mockImplementation(async () => []);
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('copilot SDK vertical through the real factory and canonical runtime', () => {
  it('CONTROL: persists final text, vendor id and completion through the canonical owners', async () => {
    const c = composition();
    await c.runtime.startOrLoad({});
    await completedTurn(c.runtime);
    expect(JSON.stringify(c.committed.mock.calls)).toContain('SPIKE-SYNTHETIC-MARKER');
    expect(c.session.getMetadataSnapshot()?.copilotSessionId).toBe(NATIVE_SESSION_ID);
    expect(c.sink.mock.calls.some((call) => call[1].type === 'task_complete')).toBe(true);
  });

  // D1: durable backend affinity.
  it('D1: an SDK session stays SDK after a persisted turn and factory reconstruction', async () => {
    const c = composition();
    await c.runtime.startOrLoad({});
    await completedTurn(c.runtime);
    await c.runtime.reset();

    // Reopening is an EXISTING launch: only the durable affinity may keep it on
    // the SDK. If affinity were not persisted, this would fall back to ACP.
    const reopened = createCopilotRuntime({
      ...c.params,
      sessionLaunchOrigin: 'existing',
    } as Parameters<typeof createCopilotRuntime>[0]);
    cleanups.push(() => reopened.reset());
    expect(reopened.runtimeKind).toBe('sdk');
  });

  it('D1: a Copilot-flavored session with no authoritative created origin stays ACP', () => {
    // Fresh launches already carry flavor:'copilot', so flavor proves nothing;
    // the origin is what withholds the SDK here.
    expect(
      composition(createTestMetadata({ flavor: 'copilot' }), {}, 'existing').runtime.runtimeKind,
    ).toBe('acp');
    expect(
      composition(createTestMetadata({ flavor: 'copilot' }), {}, 'unknown').runtime.runtimeKind,
    ).toBe('acp');
  });

  it('CONTROL: ACP remains the default and an existing ACP vendor id stays ACP', () => {
    expect(
      composition(createTestMetadata(), { HAPPIER_COPILOT_SDK_EXPERIMENT: '0' }).runtime.runtimeKind,
    ).toBe('acp');
    // A vendor id identifies the native session, not its transport: it neither
    // opts in nor conflicts. The 'existing' origin is what keeps this on ACP.
    expect(
      composition(createTestMetadata({ copilotSessionId: 'acp-owned' }), {}, 'existing').runtime
        .runtimeKind,
    ).toBe('acp');
  });

  // D6: the configured ceiling must reach the backend through the real factory.
  it('D6: the configured model-call ceiling reaches the consumed backend', async () => {
    const c = composition(createTestMetadata(), { HAPPIER_COPILOT_SDK_MAX_MODEL_CALLS: '2' });
    await c.runtime.startOrLoad({});
    emit('assistant.usage', { apiCallId: 'spike-1', model: 'm', inputTokens: 2, outputTokens: 1 });
    emit('assistant.usage', { apiCallId: 'spike-2', model: 'm', inputTokens: 2, outputTokens: 1 });
    await expect(completedTurn(c.runtime)).rejects.toThrow(/ceiling/i);
    expect(wire.send).not.toHaveBeenCalled();
  });

  // Q2-F6: accounting must be durable, because an external live driver cannot
  // read in-process getters after the owned runtime has terminated. Proven
  // through the REAL factory: the previous ceiling defect was exactly a value
  // that never reached the backend.
  it('Q2-F6: the configured accounting sink reaches the consumed backend', async () => {
    const scratch = createSpikeScratchDir('consumed-sink');
    const sinkPath = join(scratch.path, 'usage.jsonl');
    const c = composition(createTestMetadata(), { HAPPIER_COPILOT_SDK_USAGE_SINK: sinkPath });
    // The runtime writes a terminal accounting record while it is disposed, which
    // happens in afterEach. Removing the directory inline at the end of this test
    // body deleted the sink out from under that write, so the run reported a
    // genuine ENOENT accounting failure that belonged to the fixture, not the
    // product. Registering cleanup on the shared stack after the runtime's own
    // reset keeps the sink alive until its last writer is gone.
    cleanups.push(async () => scratch.cleanup());
    await c.runtime.startOrLoad({});

    emit('assistant.usage', {
      apiCallId: 'spike-consumed-1',
      model: 'm',
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      prompt: 'SECRET PROMPT',
    });

    const raw = readFileSync(sinkPath, 'utf8');
    expect(raw).not.toContain('SECRET PROMPT');
    const record = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({ apiCallId: 'spike-consumed-1', totalTokens: 3 });
  });

  it('D6: reaching the ceiling mid-turn stops the in-flight native turn', async () => {
    const b = backend({ modelCallCeiling: 2 });
    await b.startSession();
    wire.send.mockImplementation(async () => {
      for (let i = 1; i <= 3; i += 1) {
        emit('assistant.usage', { apiCallId: `spike-${i}`, model: 'm', inputTokens: 1, outputTokens: 1 });
      }
    });
    await b.sendPrompt(NATIVE_SESSION_ID, 'SPIKE');
    await expect(b.waitForResponseComplete()).rejects.toThrow(/ceiling/i);
    expect(wire.abort).toHaveBeenCalled();
  });

  // D2: autopilot idle is not the end of a turn.
  it('D2: autopilot idle does not complete the turn before the continuation', async () => {
    wire.send.mockImplementation(async () => {
      emit('assistant.message', { content: 'SPIKE-INTERMEDIATE' });
      emit('session.idle', { mode: 'autopilot' });
    });
    const c = composition();
    await c.runtime.startOrLoad({});
    c.runtime.beginTurn();
    let finished = false;
    const turn = c.runtime.sendPrompt('SPIKE-CONTINUE').then(async () => {
      await c.runtime.flushTurn();
      finished = true;
    });
    await tick();
    await tick();
    const premature = finished;
    const prematureComplete = c.sink.mock.calls.some((call) => call[1].type === 'task_complete');

    emit('assistant.message', { content: 'SPIKE-FINAL' });
    emit('session.idle', { mode: 'interactive' });
    await turn;
    await c.runtime.flushTurn();

    expect({ premature, prematureComplete }).toEqual({ premature: false, prematureComplete: false });
  });

  // D7: native usage must reach the canonical token telemetry owner.
  it('D7: native camelCase usage reaches the canonical token_count sink', async () => {
    wire.send.mockImplementation(async () => {
      emit('assistant.usage', {
        apiCallId: 'spike-usage',
        model: 'spike-model',
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
      });
      emit('session.idle', { mode: 'interactive' });
    });
    const c = composition();
    await c.runtime.startOrLoad({});
    await completedTurn(c.runtime);
    expect(c.sink.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({
        type: 'token_count',
        tokens: expect.objectContaining({ input: 12, output: 3, cache_read: 4 }),
      }),
    );
  });

  // D8: tool failure state and reason must survive canonical persistence.
  it('D8: success=false without an optional error stays a failed tool result', async () => {
    wire.send.mockImplementation(async () => {
      emit('tool.execution_start', { toolCallId: 'spike-fail', toolName: 'read', arguments: {} });
      emit('tool.execution_complete', { toolCallId: 'spike-fail', success: false });
      emit('session.idle', { mode: 'interactive' });
    });
    const c = composition();
    await c.runtime.startOrLoad({});
    await completedTurn(c.runtime);
    expect(c.sink.mock.calls.map((call) => call[1])).toContainEqual(
      expect.objectContaining({ type: 'tool-result', callId: 'spike-fail', isError: true }),
    );
  });

  it('D8: native tool error detail survives canonical persistence', async () => {
    wire.send.mockImplementation(async () => {
      emit('tool.execution_start', { toolCallId: 'spike-err', toolName: 'read', arguments: {} });
      emit('tool.execution_complete', {
        toolCallId: 'spike-err',
        success: false,
        error: { message: 'SPIKE-read-denied', code: 'EACCES' },
      });
      emit('session.idle', { mode: 'interactive' });
    });
    const c = composition();
    await c.runtime.startOrLoad({});
    await completedTurn(c.runtime);
    expect(JSON.stringify(c.sink.mock.calls)).toContain('SPIKE-read-denied');
  });

  it('CONTROL: a successful tool result is not marked as an error', async () => {
    wire.send.mockImplementation(async () => {
      emit('tool.execution_start', { toolCallId: 'spike-ok', toolName: 'read', arguments: {} });
      emit('tool.execution_complete', {
        toolCallId: 'spike-ok',
        success: true,
        result: { content: 'ok' },
      });
      emit('session.idle', { mode: 'interactive' });
    });
    const c = composition();
    await c.runtime.startOrLoad({});
    await completedTurn(c.runtime);
    const toolResult = c.sink.mock.calls
      .map((call) => call[1])
      .find((message) => message.type === 'tool-result');
    expect(toolResult).toMatchObject({ callId: 'spike-ok' });
    expect(toolResult.isError).toBeUndefined();
  });

  // S1 native configuration controls (reviewer observation O1).
  it('forwards the S1-proven native discovery and file-hook controls', async () => {
    const c = composition();
    await c.runtime.startOrLoad({});
    expect(wire.config?.enableConfigDiscovery).toBe(true);
    expect(wire.config?.enableFileHooks).toBe(true);
  });

  // D3, consumed path: a native error must surface as a failed turn AND must
  // never be published as canonical completion. The canonical owner's own
  // failed-turn contract is a thrown "runtime handled turn abort", which is
  // exactly what marks the turn aborted and suppresses `task_complete`.
  it('D3: a native session error fails the turn and never publishes task_complete', async () => {
    wire.send.mockImplementation(async () => {
      emit('session.error', { message: 'SPIKE-native-failure' });
      emit('session.idle', { mode: 'interactive' });
    });
    const c = composition();
    await c.runtime.startOrLoad({});
    c.runtime.beginTurn();
    const failure = await c.runtime.sendPrompt('SPIKE-SYNTHETIC-MARKER').then(
      () => null,
      (error: unknown) => error as Error,
    );
    await c.runtime.flushTurn();
    await tick();

    // The failure is observable rather than swallowed into a success shape...
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error & { cause?: unknown }).cause)).toContain(
      'SPIKE-native-failure',
    );
    // ...and no completion was published for the failed turn.
    expect(c.sink.mock.calls.some((call) => call[1].type === 'task_complete')).toBe(false);
  });

  // D3/Q2-F3: when the abort ITSELF fails, the aggregated message legitimately
  // contains the word "abort". An unmarked failure would then be read as a user
  // cancellation by the shared classifier and the prompt loop would publish
  // task_complete for a turn that actually failed.
  it('D3: a failed turn whose abort also fails is never reclassified as cancellation', async () => {
    wire.send.mockImplementation(async () => {
      emit('session.error', { message: 'SPIKE-native-failure' });
    });
    wire.abort.mockRejectedValue(new Error('SPIKE-abort-failed'));
    const c = composition();
    await c.runtime.startOrLoad({});
    c.runtime.beginTurn();
    const failure = await c.runtime.sendPrompt('SPIKE-SYNTHETIC-MARKER').then(
      () => null,
      (error: unknown) => error as Error,
    );
    await c.runtime.flushTurn();
    await tick();

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/abort/i);
    // The explicit marker must win over the abort-shaped wording.
    expect(isAbortLikeError(failure)).toBe(false);
    expect(c.sink.mock.calls.some((call) => call[1].type === 'task_complete')).toBe(false);
  });
});

describe('copilot SDK backend fault, settlement and permission boundaries', () => {
  // D3: terminal outcome must win over a racing idle.
  it('D3: a timeout stays a failure even if abort synchronously emits idle', async () => {
    const b = backend();
    await b.startSession();
    wire.abort.mockImplementation(async () => {
      emit('session.idle', { mode: 'interactive' });
    });
    await expect(b.waitForResponseComplete(10)).rejects.toThrow(/timed out/i);
  });

  it('D3: native session.error settles the waiter without waiting for idle', async () => {
    const b = backend();
    await b.startSession();
    let outcome = 'pending';
    const wait = b.waitForResponseComplete(500).then(
      () => {
        outcome = 'success';
      },
      () => {
        outcome = 'failure';
      },
    );
    emit('session.error', { message: 'SPIKE-session-error' });
    await tick();
    const afterError = outcome;
    emit('session.idle', { mode: 'interactive' });
    await wait;
    expect(afterError).toBe('failure');
  });

  // A terminal native failure is the ONLY thing that explains a turn ending as
  // `provider_session_error`, yet nothing on the consumed path records it: this
  // branch merely stores the error on the turn outcome, and the canonical owner
  // sanitizes it to the fixed preview "Provider session failed" without logging
  // the detail at any level. An installed acceptance run therefore produced a
  // failed turn whose cause could not be recovered from any signal. The native
  // message must be reported on a default-on signal.
  it('D3: a native session error is reported on a default-on signal', async () => {
    const { logger } = await import('@/ui/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const b = backend();
      await b.startSession();
      emit('session.error', { message: 'SPIKE-native-failure-detail' });
      await tick();

      const reported = warn.mock.calls
        .map((call) => call.map((part) => String(part)).join(' '))
        .filter((line) => line.includes('SPIKE-native-failure-detail'));
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain('[copilot-sdk]');
    } finally {
      warn.mockRestore();
    }
  });

  it('CONTROL: a normal non-autopilot idle still settles the turn successfully', async () => {
    const b = backend();
    await b.startSession();
    await b.sendPrompt(NATIVE_SESSION_ID, 'SPIKE');
    await expect(b.waitForResponseComplete()).resolves.toBeUndefined();
  });

  // D4: cleanup must always attempt native stop and must not hide failures.
  it('D4: canonical reset stops the native client even when disconnect throws', async () => {
    const c = composition();
    await c.runtime.startOrLoad({});
    wire.disconnect.mockRejectedValue(new Error('SPIKE-disconnect-fault'));
    await c.runtime.reset();
    await c.runtime.reset();
    expect(wire.stop).toHaveBeenCalledTimes(1);
  });

  it('D4: a failed native stop is not reported as clean disposal', async () => {
    const b = backend();
    await b.startSession();
    wire.stop.mockResolvedValue([new Error('SPIKE-native-stop-failed')]);
    await expect(b.dispose()).rejects.toThrow(/stop|cleanup/i);
  });

  it('D4: a failed disposal remains retryable rather than latched clean', async () => {
    const b = backend();
    await b.startSession();
    wire.stop.mockResolvedValueOnce([new Error('SPIKE-native-stop-failed')]);
    await expect(b.dispose()).rejects.toThrow(/stop|cleanup/i);
    wire.stop.mockResolvedValue([]);
    await expect(b.dispose()).resolves.toBeUndefined();
    expect(wire.stop).toHaveBeenCalledTimes(2);
  });

  // D4/reconciliation: the shared ACP runtime owner must not hand out a fresh
  // backend while the previous native runtime's termination is unproved. The
  // SDK backend reports an unverified shutdown by failing dispose(), so this
  // pins the shared owner's response to it: the reset is reported as failed,
  // ownership is retained, and the replacement startup is refused rather than
  // silently succeeding on top of a process that may still be alive.
  it('D4: an unproved termination blocks replacement startup at the shared runtime owner', async () => {
    const c = composition();
    await c.runtime.startOrLoad({});

    wire.stop.mockResolvedValue([new Error('SPIKE-native-stop-failed')]);
    await expect(c.runtime.reset()).rejects.toThrow(/cleanup|reset/i);

    // Even with a healthy native transport, the runtime must refuse to start a
    // replacement until the unproved shutdown is resolved.
    wire.create.mockClear();
    await expect(c.runtime.startOrLoad({})).rejects.toThrow(/cannot start a new backend/i);
    expect(wire.create).not.toHaveBeenCalled();
  });

  // D5: approve-once must not be reused across distinct native requests.
  it('D5: distinct native permission requests each need their own host approval', async () => {
    const requests: string[] = [];
    const rpcHandlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const session = createMutableApiSessionClientFixture({
      metadata: createTestMetadata({ permissionMode: 'default' }),
      overrides: {
        updateAgentState: vi.fn(),
        rpcHandlerManager: {
          registerHandler: (name: string, fn: (payload: unknown) => Promise<unknown>) => {
            rpcHandlers.set(name, fn);
          },
        } as ReturnType<typeof createMutableApiSessionClientFixture>['rpcHandlerManager'],
      },
    });
    const owner = new CopilotPermissionHandler(session);
    const b = backend({
      onPermissionRequest: async (id, name, input) => {
        requests.push(id);
        const response = await owner.handleToolCall(id, name, input);
        return response.decision === 'approved'
          ? { kind: 'approve-once' }
          : { kind: 'reject', feedback: 'SPIKE-denied' };
      },
    });
    await b.startSession();

    const callback = wire.config?.onPermissionRequest as (
      request: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<unknown>;
    const request = {
      kind: 'write',
      toolCallId: 'spike-tool-1',
      fileName: '/spike/a',
      canOfferSessionApproval: true,
      diff: '+SPIKE',
      intention: 'write synthetic marker',
    };

    const first = callback(request, { sessionId: NATIVE_SESSION_ID });
    await tick();
    const respond = rpcHandlers.get('permission');
    if (!respond) throw new Error('permission RPC handler was never registered');
    await respond({ id: requests[0], approved: true, decision: 'approved' });
    expect(await first).toMatchObject({ kind: 'approve-once' });

    let secondResolved = false;
    const second = Promise.resolve(callback({ ...request }, { sessionId: NATIVE_SESSION_ID })).then(
      (result) => {
        secondResolved = true;
        return result;
      },
    );
    await tick();
    const autoResolved = secondResolved;
    await respond({ id: requests[1], approved: false, decision: 'denied' });
    await second;

    expect({ uniqueIds: new Set(requests).size, autoResolved }).toEqual({
      uniqueIds: 2,
      autoResolved: false,
    });
  });
});
