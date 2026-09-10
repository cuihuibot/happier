/**
 * Regression tests for the Copilot SDK backend (spike, host-only).
 *
 * These cover the seven source-traced repair findings S2-Q-01..S2-Q-07. Each
 * test asserts an observable contract of the backend boundary that the
 * canonical `createAcpRuntime` owner consumes, not the backend's internals.
 *
 * The only mocked boundary is the pinned `@github/copilot-sdk` client, which is
 * a genuine external process/transport adapter. The projection, settlement,
 * permission-identity and lifecycle logic under test is the real implementation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';

/** Minimal in-memory stand-in for the native SDK session/client transport. */
function createFakeSdk() {
  const listeners: ((event: unknown) => void)[] = [];
  const calls = {
    abort: 0,
    disconnect: 0,
    clientStop: 0,
    send: [] as string[],
    resumed: [] as string[],
    createdConfigs: [] as Record<string, unknown>[],
  };

  const session = {
    sessionId: 'native-session-1',
    send: vi.fn(async (prompt: string) => {
      calls.send.push(prompt);
      return 'req-1';
    }),
    abort: vi.fn(async () => {
      calls.abort += 1;
    }),
    disconnect: vi.fn(async () => {
      calls.disconnect += 1;
    }),
  };

  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      calls.clientStop += 1;
      return [] as Error[];
    }),
    createSession: vi.fn(async (config: Record<string, unknown>) => {
      calls.createdConfigs.push(config);
      if (typeof config.onEvent === 'function') {
        listeners.push(config.onEvent as (event: unknown) => void);
      }
      return session;
    }),
    resumeSession: vi.fn(async (sessionId: string, config: Record<string, unknown>) => {
      calls.resumed.push(sessionId);
      if (typeof config.onEvent === 'function') {
        listeners.push(config.onEvent as (event: unknown) => void);
      }
      return { ...session, sessionId };
    }),
  };

  return {
    client,
    session,
    calls,
    emit: (event: unknown) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

async function loadBackendModule() {
  return import('./backend');
}

/** Builds a backend bound to the fake transport, collecting emitted messages. */
async function buildBackend(overrides: Record<string, unknown> = {}) {
  const sdk = createFakeSdk();
  const mod = await loadBackendModule();
  const messages: AgentMessage[] = [];

  const backend = mod.createCopilotSdkBackend({
    cliPath: '/fixture/copilot',
    directory: '/fixture/workdir',
    createClient: () => sdk.client as never,
    ...overrides,
  } as never);

  backend.onMessage((msg: AgentMessage) => messages.push(msg));
  return { backend, sdk, messages, mod };
}

describe('copilot/sdk/backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // S2-Q-01: assistant/tool/usage must reach the canonical runtime as normalized
  // AgentMessages, not only a local MessageBuffer.
  it('projects native assistant, tool and usage events onto normalized AgentMessages', async () => {
    const { backend, sdk, messages } = await buildBackend();
    await backend.startSession();

    sdk.emit({ type: 'assistant.message', data: { content: 'marker text' } });
    sdk.emit({
      type: 'tool.execution_start',
      data: { toolCallId: 'tc-1', toolName: 'write', arguments: { path: '/x' } },
    });
    sdk.emit({
      type: 'tool.execution_complete',
      data: { toolCallId: 'tc-1', toolName: 'write', success: true, result: { ok: true } },
    });
    // Pinned native usage is camelCase per-counter, never a `totalTokens` field.
    sdk.emit({
      type: 'assistant.usage',
      data: { apiCallId: 'api-1', model: 'm', inputTokens: 30, outputTokens: 12 },
    });

    expect(messages.find((m) => m.type === 'model-output')).toMatchObject({
      type: 'model-output',
      fullText: 'marker text',
    });
    expect(messages.find((m) => m.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      toolName: 'write',
      callId: 'tc-1',
    });
    expect(messages.find((m) => m.type === 'tool-result')).toMatchObject({
      type: 'tool-result',
      callId: 'tc-1',
    });
    // Usage is telemetry, not transcript text: it must not become model output.
    expect(messages.filter((m) => m.type === 'model-output')).toHaveLength(1);
    expect(messages.find((m) => m.type === 'token-count')).toBeTruthy();
  });

  // S2-Q-01: the backend must never emit its own task_complete; the canonical
  // runtime owns turn completion.
  it('never emits a task_complete of its own', async () => {
    const { backend, sdk, messages } = await buildBackend();
    await backend.startSession();
    sdk.emit({ type: 'session.idle', data: {} });

    const names = messages.map((m) => JSON.stringify(m));
    expect(names.some((n) => n.includes('task_complete'))).toBe(false);
  });

  // S2-Q-02: resume must use the typed resumeSession API, never createSession
  // with an unsupported resumeSessionId that silently creates a new session.
  it('resumes through the typed resumeSession API and fails closed on vendor mismatch', async () => {
    const { backend, sdk } = await buildBackend();

    const loaded = await backend.loadSession('native-session-7');
    expect(sdk.calls.resumed).toEqual(['native-session-7']);
    expect(loaded.sessionId).toBe('native-session-7');
    // A resume must never be silently replaced by a fresh session.
    expect(sdk.client.createSession).not.toHaveBeenCalled();

    const mismatched = await buildBackend();
    mismatched.sdk.client.resumeSession = vi.fn(async () => ({
      ...mismatched.sdk.session,
      sessionId: 'a-different-session',
    })) as never;
    await expect(mismatched.backend.loadSession('native-session-9')).rejects.toThrow(
      /resume|mismatch/i,
    );
  });

  // S2-Q-03: a constant permission id collides across concurrent/repeat requests
  // in the canonical permission corridor.
  it('gives every permission request a distinct identity and never a shared constant', async () => {
    const seen: string[] = [];
    const seenInputs: Record<string, unknown>[] = [];
    const { backend, sdk } = await buildBackend({
      onPermissionRequest: async (
        permissionId: string,
        _toolName: string,
        input: Record<string, unknown>,
      ) => {
        seen.push(permissionId);
        seenInputs.push(input);
        return { kind: 'reject', feedback: 'no' };
      },
    });
    await backend.startSession();

    const handler = sdk.calls.createdConfigs[0].onPermissionRequest as (
      request: unknown,
      invocation: unknown,
    ) => Promise<unknown>;

    // Two structurally identical requests without a native toolCallId.
    await handler({ kind: 'shell', fullCommandText: 'ls' }, { sessionId: 's' });
    await handler({ kind: 'shell', fullCommandText: 'ls' }, { sessionId: 's' });
    // One request carrying a real native tool call id.
    await handler(
      { kind: 'shell', fullCommandText: 'ls', toolCallId: 'native-tc-9' },
      { sessionId: 's' },
    );

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).not.toContain('copilot-sdk-permission');
    // D5: `toolCallId` is a tool-execution identity, not an authorization
    // identity, and the pinned callback never receives the native requestId.
    // It must therefore never BE the permission id — it is carried separately
    // as correlation so the canonical owner can still relate the two.
    expect(seen[2]).not.toBe('native-tc-9');
    expect(seenInputs[2]).toMatchObject({ nativeToolCallId: 'native-tc-9' });
  });

  // S2-Q-04: assistant.idle can fire while background work is still pending;
  // only session.idle is terminal settlement.
  it('settles a turn on session.idle, not on a premature assistant.idle', async () => {
    const { backend, sdk } = await buildBackend();
    await backend.startSession();

    const settled = backend.waitForResponseComplete(5_000);
    let done = false;
    void settled.then(() => {
      done = true;
    });

    sdk.emit({ type: 'assistant.idle', data: {} });
    // Flush the macrotask queue so a premature settlement would be observable;
    // a single microtask tick is not enough to catch it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);

    sdk.emit({ type: 'session.idle', data: {} });
    await settled;
    expect(done).toBe(true);
  });

  // S2-Q-04: a settlement timeout must abort and join native work, never just
  // unsubscribe and report a clean turn while work continues.
  it('aborts and joins native work when settlement times out', async () => {
    const { backend, sdk } = await buildBackend();
    await backend.startSession();

    await expect(backend.waitForResponseComplete(10)).rejects.toThrow(/timed out|timeout/i);
    expect(sdk.calls.abort).toBeGreaterThan(0);
  });

  // S2-Q-05: dispose is the contract cleanup the runtime calls; it must stop the
  // owned client, not merely detach the session.
  it('stops the owned client on dispose, idempotently', async () => {
    const { backend, sdk } = await buildBackend();
    await backend.startSession();

    await backend.dispose();
    await backend.dispose();

    expect(sdk.calls.clientStop).toBe(1);
    expect(sdk.calls.disconnect).toBe(1);
  });

  // S2-Q-05: a failure during start must still release the owned client.
  it('releases the owned client when session creation fails', async () => {
    const sdk = createFakeSdk();
    sdk.client.createSession = vi.fn(async () => {
      throw new Error('native create failed');
    }) as never;

    const mod = await loadBackendModule();
    const backend = mod.createCopilotSdkBackend({
      cliPath: '/fixture/copilot',
      directory: '/fixture/workdir',
      createClient: () => sdk.client as never,
    } as never);

    await expect(backend.startSession()).rejects.toThrow(/native create failed/);
    expect(sdk.calls.clientStop).toBe(1);
  });

  // S2-Q-06: the host-resolved per-session environment and MCP servers must
  // reach the native runtime instead of being discarded to ambient env.
  // Pinned contract: `env` belongs to RuntimeConnection.forStdio (types.d.ts:292,
  // "If not set, inherits process.env"); `mcpServers` belongs to SessionConfig.
  it('passes the host-managed environment and MCP servers into the native session', async () => {
    const sdk = createFakeSdk();
    const connectionOptions: Record<string, unknown>[] = [];
    const mod = await loadBackendModule();
    const backend = mod.createCopilotSdkBackend({
      cliPath: '/fixture/copilot',
      directory: '/fixture/workdir',
      processEnv: { HAPPIER_SESSION_ID: 'happier-1', PATH: '/usr/bin' },
      mcpServers: { marker: { command: '/bin/marker', args: [] } },
      createClient: (options: Record<string, unknown>) => {
        connectionOptions.push(options);
        return sdk.client as never;
      },
    } as never);

    await backend.startSession();

    // The managed environment must reach the runtime process, not ambient env.
    expect(connectionOptions[0]).toMatchObject({
      path: '/fixture/copilot',
      env: { HAPPIER_SESSION_ID: 'happier-1' },
    });
    // MCP servers are session-scoped configuration.
    expect(sdk.calls.createdConfigs[0].mcpServers).toMatchObject({
      marker: { command: '/bin/marker' },
    });
  });

  // S2-Q-07: the credit option is a strict positive integer; prefix parses and
  // fractional-to-zero truthiness must not silently disable the guard.
  it('validates maxAiCredits strictly instead of accepting prefixes or dropping fractions', async () => {
    const mod = await loadBackendModule();

    expect(mod.resolveMaxAiCredits(30)).toBe(30);
    expect(mod.resolveMaxAiCredits(undefined)).toBeUndefined();
    // "30abc" must not parse as 30.
    expect(() => mod.resolveMaxAiCredits('30abc' as never)).toThrow(/credit/i);
    // 0.5 must not silently become 0 or be dropped as falsy.
    expect(() => mod.resolveMaxAiCredits(0.5 as never)).toThrow(/credit/i);
    expect(() => mod.resolveMaxAiCredits(0 as never)).toThrow(/credit/i);
    expect(() => mod.resolveMaxAiCredits(-5 as never)).toThrow(/credit/i);
  });

  // S2-Q-02: model semantics must not be silently dropped. The pinned SDK
  // exposes session.setModel (session.d.ts:312), so the backend forwards the
  // change instead of discarding it or faking success.
  it('forwards a model change to the native session instead of dropping it', async () => {
    const sdk = createFakeSdk();
    const setModel = vi.fn(async () => ({}));
    (sdk.session as unknown as Record<string, unknown>).setModel = setModel;

    const mod = await loadBackendModule();
    const backend = mod.createCopilotSdkBackend({
      cliPath: '/fixture/copilot',
      directory: '/fixture/workdir',
      createClient: () => sdk.client as never,
    } as never);

    await backend.startSession();
    await backend.setSessionModel('native-session-1', 'gpt-5-mini');
    expect(setModel).toHaveBeenCalledWith('gpt-5-mini');
  });

  // S2-Q-07: usage must be observable from before the first send through
  // shutdown, because the native events are ephemeral and cannot be replayed.
  it('records an ephemeral usage observation sink that survives shutdown', async () => {
    const { backend, sdk } = await buildBackend();
    await backend.startSession();

    expect(backend.getUsageObservations()).toEqual([]);

    sdk.emit({
      type: 'assistant.usage',
      data: { apiCallId: 'api-1', model: 'm', inputTokens: 5, outputTokens: 2 },
    });
    sdk.emit({
      type: 'assistant.usage',
      data: { apiCallId: 'api-2', model: 'm', inputTokens: 6, outputTokens: 3 },
    });
    await backend.dispose();

    const observations = backend.getUsageObservations();
    expect(observations).toHaveLength(2);
    // D6: only sanitized typed accounting fields are retained — never the raw
    // native payload, so no prompt or tool content can reach an evidence sink.
    expect(observations[0]).toMatchObject({
      apiCallId: 'api-1',
      model: 'm',
      tokens: { input: 5, output: 2 },
    });
    expect(observations[0]).not.toHaveProperty('raw');
    // Post-request accounting: the count of observed calls is reported, never
    // asserted as a proven spend cap.
    expect(backend.getObservedModelCallCount()).toBe(2);
  });

  it('refuses a further send once the observed model-call ceiling is reached', async () => {
    // The native `maxAiCredits` floor is a soft post-paid threshold, not a hard
    // spend cap, so the host needs its own fail-closed stop. Accounting alone
    // would let an unbounded run continue while merely being counted.
    const { backend, sdk } = await buildBackend({ modelCallCeiling: 2 });
    await backend.startSession();

    await backend.sendPrompt('s', 'first');
    sdk.emit({ type: 'assistant.usage', data: { apiCallId: 'api-1' } });
    await backend.sendPrompt('s', 'second');
    sdk.emit({ type: 'assistant.usage', data: { apiCallId: 'api-2' } });

    await expect(backend.sendPrompt('s', 'third')).rejects.toThrow(/ceiling/i);
    expect(backend.getObservedModelCallCount()).toBe(2);
  });

  // S2-Q-04 (consumed-path): the canonical owner calls `waitForResponseComplete()`
  // with NO argument (createAcpRuntime.ts:2184,2565). A caller-supplied timeout is
  // therefore never present in the real vertical, so the backend must bound the
  // wait itself. Unlike the Codex/PI backends, this one has no native liveness
  // signal, so an unbounded wait means a silently dead native runtime hangs the
  // host prompt loop forever.
  it('bounds and aborts a turn when the canonical owner supplies no timeout', async () => {
    const { backend, sdk } = await buildBackend({ settlementTimeoutMs: 40 });
    await backend.startSession();
    await backend.sendPrompt('s', 'prompt');

    // Native never emits `session.idle` — simulates a dead/stuck runtime.
    await expect(backend.waitForResponseComplete()).rejects.toThrow(/timed out/i);
    // The timeout must abort native work, not merely stop listening.
    expect(sdk.calls.abort).toBe(1);
  });
});
