import { describe, expect, it, vi } from 'vitest';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCopilotSdkBackend } from './backend';

/**
 * Composition proof for the SDK vertical.
 *
 * These tests deliberately compose the *real* canonical `createAcpRuntime`
 * owner with the SDK backend over a fake native transport. A backend-only test
 * can prove projection but cannot prove that the canonical session sink
 * actually persists the normalized events or emits final completion, which is
 * the contract the reviewer faulted as unproven.
 *
 * The only mocked element is the genuine external boundary: the native Copilot
 * runtime process reached over stdio.
 */

/** Minimal stand-in for the external native runtime reached over stdio. */
function createFakeNativeRuntime() {
  let emitEvent: ((event: { type: string; data?: unknown }) => void) | null = null;
  let idleDuringSend = false;
  const sent: string[] = [];
  const emit = (event: { type: string; data?: unknown }) => {
    if (!emitEvent) throw new Error('native session was never created');
    emitEvent(event);
  };
  const session = {
    sessionId: 'native-session-1',
    send: vi.fn(async (prompt: string) => {
      sent.push(prompt);
      if (idleDuringSend) emit({ type: 'session.idle', data: { mode: 'default' } });
    }),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    createSession: vi.fn(async (config: { onEvent?: (e: { type: string; data?: unknown }) => void }) => {
      emitEvent = config.onEvent ?? null;
      return session;
    }),
    resumeSession: vi.fn(async () => session),
  };
  return {
    client,
    session,
    sent,
    emit,
    /** Makes the native runtime settle inside `send`, before the host waits. */
    settleDuringSend() {
      idleDuringSend = true;
    },
  };
}

function createComposition() {
  const native = createFakeNativeRuntime();
  const sendAgentMessage = vi.fn();
  const sendAgentMessageCommitted = vi.fn(async () => {});
  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: '/tmp/spike',
    session: createBasicSessionClientWithOverrides({ sendAgentMessage, sendAgentMessageCommitted }),
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () =>
      createCopilotSdkBackend({
        cliPath: '/nonexistent/copilot',
        directory: '/tmp/spike',
        createClient: () => native.client as never,
      }),
  });
  return { native, runtime, sendAgentMessage, sendAgentMessageCommitted };
}

/** Collects the normalized envelopes the canonical session sink received. */
function sinkEnvelopes(sendAgentMessage: ReturnType<typeof vi.fn>): { type: string; [k: string]: unknown }[] {
  return sendAgentMessage.mock.calls.map((call) => call[1] as { type: string });
}

describe('copilot/sdk composition with the canonical ACP runtime', () => {
  it('persists normalized assistant text, tool events and final completion through the canonical sink', async () => {
    const { native, runtime, sendAgentMessage, sendAgentMessageCommitted } = createComposition();
    await runtime.startOrLoad({});

    // The canonical owner's sendPrompt blocks until native settlement, so the
    // native events must be driven concurrently with the in-flight turn.
    runtime.beginTurn();
    const turn = runtime.sendPrompt('hello');
    await new Promise((resolve) => setTimeout(resolve, 5));

    native.emit({ type: 'assistant.message', data: { content: 'HAP-SDK-MARKER' } });
    native.emit({
      type: 'tool.execution_start',
      data: { toolCallId: 'call-1', toolName: 'read', arguments: { path: 'a.txt' } },
    });
    native.emit({
      type: 'tool.execution_complete',
      data: { toolCallId: 'call-1', toolName: 'read', result: 'ok' },
    });
    native.emit({ type: 'session.idle', data: { mode: 'default' } });

    await turn;
    await runtime.flushTurn();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const envelopes = sinkEnvelopes(sendAgentMessage);
    const types = envelopes.map((e) => e.type);
    // The sink must receive normalized envelopes, not raw native events and not
    // only a local in-memory buffer append.
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    // Assistant text is persisted through the canonical committed-message sink
    // at turn end, not through the streaming envelope path.
    expect(JSON.stringify(sendAgentMessageCommitted.mock.calls)).toContain('HAP-SDK-MARKER');
    // task_complete is owned by createAcpRuntime; the SDK vertical must not
    // duplicate that heuristic, so composition is the only honest proof.
    expect(types).toContain('task_complete');
    expect(native.client.createSession).toHaveBeenCalledTimes(1);
  });

  it('settles a turn whose native idle arrived before the host began waiting', async () => {
    // Reproduces the real ordering hazard: the native runtime settles during
    // the send itself, before the host registers its settlement waiter. A
    // waiter-only signal is dropped there and the host hangs for the turn.
    const { native, runtime } = createComposition();
    native.settleDuringSend();
    await runtime.startOrLoad({});

    runtime.beginTurn();
    await expect(runtime.sendPrompt('hello')).resolves.not.toThrow();
    await runtime.flushTurn();
  });

  it('drives cleanup of the owned native runtime through the canonical reset contract', async () => {
    const { native, runtime } = createComposition();
    await runtime.startOrLoad({});

    // runStandardAcpProvider calls runtime.reset() for normal host cleanup, so
    // reset must reach the owned client, not merely detach the session.
    await runtime.reset();

    expect(native.session.disconnect).toHaveBeenCalledTimes(1);
    expect(native.client.stop).toHaveBeenCalledTimes(1);
  });
});
