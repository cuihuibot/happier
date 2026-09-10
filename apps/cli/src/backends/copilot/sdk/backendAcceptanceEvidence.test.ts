/**
 * IQE-SDK-AC08-ANCHOR-001 regression: provider-input acceptance timing.
 *
 * The canonical Pending custody contract commits a claimed pending row into the
 * transcript only after the backend reports a terminal provider-input outcome
 * `accepted`. On the ACP seam that acceptance is published by
 * `createAcpRuntime.sendPromptToProvider` ONLY when the backend returns
 * `AcpPromptSubmissionEvidence`; otherwise acceptance is deferred until the
 * whole turn completes, because that function awaits `waitForResponseComplete()`.
 *
 * A turn that is still pending on a held tool permission therefore never
 * anchors the user's own message. The canonical meaning is defined by
 * `AcpBackend.sendPromptWithEvidence`: once the prompt transport write is
 * acknowledged, the input is `accepted_without_exact_final_response` even
 * though no final response exists yet.
 *
 * The only mocked boundary is the pinned `@github/copilot-sdk` transport.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SdkEventListener = (event: unknown) => void;

/**
 * In-memory stand-in for the native SDK session/client transport, matching the
 * pinned 1.0.13 shape: `session.send` resolves with a messageId once the native
 * runtime acknowledges custody of the input, and turn completion is reported
 * separately through events.
 */
function createFakeSdk(options: { sendBehavior?: () => Promise<string> } = {}) {
  const listeners: SdkEventListener[] = [];
  const calls = { send: [] as string[], abort: 0 };

  const session = {
    sessionId: 'native-session-anchor',
    send: vi.fn(async (prompt: string) => {
      calls.send.push(prompt);
      if (options.sendBehavior) return await options.sendBehavior();
      return 'native-message-1';
    }),
    abort: vi.fn(async () => {
      calls.abort += 1;
    }),
    disconnect: vi.fn(async () => {}),
  };

  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => [] as Error[]),
    createSession: vi.fn(async (config: Record<string, unknown>) => {
      if (typeof config.onEvent === 'function') listeners.push(config.onEvent as SdkEventListener);
      return session;
    }),
    resumeSession: vi.fn(async (sessionId: string, config: Record<string, unknown>) => {
      if (typeof config.onEvent === 'function') listeners.push(config.onEvent as SdkEventListener);
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

async function buildBackend(overrides: Record<string, unknown> = {}) {
  const sdk = createFakeSdk(
    typeof overrides.sendBehavior === 'function'
      ? { sendBehavior: overrides.sendBehavior as () => Promise<string> }
      : {},
  );
  const mod = await import('./backend');
  const backend = mod.createCopilotSdkBackend({
    cliPath: '/fixture/copilot',
    directory: '/fixture/workdir',
    createClient: () => sdk.client as never,
    ...overrides,
  } as never);
  return { backend, sdk };
}

describe('copilot/sdk/backend provider-input acceptance timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the canonical ACP submission-evidence seam', async () => {
    const { backend } = await buildBackend();
    expect(typeof (backend as { sendPromptWithEvidence?: unknown }).sendPromptWithEvidence).toBe(
      'function',
    );
  });

  it('reports acceptance once the native runtime acknowledges input custody, while the turn is still pending', async () => {
    const { backend, sdk } = await buildBackend();
    const started = await backend.startSession();

    const evidence = await (
      backend as unknown as {
        sendPromptWithEvidence: (sessionId: string, prompt: string) => Promise<{ kind: string }>;
      }
    ).sendPromptWithEvidence(started.sessionId, 'write the marker file');

    // Custody is acknowledged...
    expect(sdk.calls.send).toEqual(['write the marker file']);
    expect(evidence.kind).toBe('accepted_without_exact_final_response');

    // ...and the turn has NOT completed: no terminal native event was emitted,
    // which is exactly the held-permission shape.
    const settled = await Promise.race([
      backend.waitForResponseComplete?.(50).then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    expect(settled).toBe('pending');
  });

  it('does not manufacture acceptance when the native send rejects before any effect', async () => {
    const { backend, sdk } = await buildBackend({
      sendBehavior: async () => {
        throw new Error('native transport refused the input');
      },
    });
    const started = await backend.startSession();

    await expect(
      (
        backend as unknown as {
          sendPromptWithEvidence: (sessionId: string, prompt: string) => Promise<unknown>;
        }
      ).sendPromptWithEvidence(started.sessionId, 'rejected input'),
    ).rejects.toThrow(/refused the input/);

    expect(sdk.calls.send).toEqual(['rejected input']);
  });

  it('keeps sendPrompt working for callers that do not consume evidence', async () => {
    const { backend, sdk } = await buildBackend();
    const started = await backend.startSession();
    await backend.sendPrompt(started.sessionId, 'plain send');
    expect(sdk.calls.send).toEqual(['plain send']);
  });
});
