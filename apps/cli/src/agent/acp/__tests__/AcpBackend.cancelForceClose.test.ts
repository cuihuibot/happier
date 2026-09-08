import { describe, expect, it } from 'vitest';
import type { PromptResponse } from '@agentclientprotocol/sdk';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Repair coverage for QF-AC-003, second half.
 *
 * The bounded cancellation fallback closes an unresponsive provider connection. Every later
 * prompt on that backend is then rejected before effect, so the session is stranded unless the
 * runtime can see that the connection is gone. This exercises the real backend cancel path
 * rather than a stubbed accessor.
 */

function createBackend(): AcpBackend {
  return new AcpBackend({
    agentName: 'test',
    cwd: process.cwd(),
    command: process.execPath,
    args: [],
    transportHandler: createAcpTestTransportHandler({ agentName: 'test', idleTimeoutMs: 1 }),
  });
}

function installPeer(
  backend: AcpBackend,
  peer: { prompt: () => Promise<PromptResponse>; cancel: () => Promise<unknown> },
): void {
  const internals = backend as unknown as {
    connection: unknown;
    acpSessionId: string | null;
  };
  internals.acpSessionId = 'test-session';
  internals.connection = {
    peer,
    close: () => {},
    closed: Promise.resolve(),
  };
}

describe('AcpBackend provider connection liveness', () => {
  it('reports no force-close before any cancellation', () => {
    const backend = createBackend();
    installPeer(backend, { prompt: async () => ({ stopReason: 'end_turn' }), cancel: async () => ({}) });
    expect(backend.isProviderConnectionForceClosed()).toBe(false);
  });

  it('reports no force-close when cancellation settles normally', async () => {
    const backend = createBackend();
    installPeer(backend, { prompt: async () => ({ stopReason: 'end_turn' }), cancel: async () => ({}) });
    await backend.cancel('test-session' as never);
    expect(
      backend.isProviderConnectionForceClosed(),
      'a provider that acknowledged cancellation must keep serving the same session',
    ).toBe(false);
  });

  it('reports a force-close after the bounded fallback closes an unresponsive provider', async () => {
    const backend = createBackend();
    installPeer(backend, {
      prompt: async () => ({ stopReason: 'end_turn' }),
      // Never acknowledges, exactly like the provider observed live during an active tool call.
      cancel: () => new Promise<never>(() => {}),
    });

    await backend.cancel('test-session' as never);

    expect(
      backend.isProviderConnectionForceClosed(),
      'a force-closed connection must be visible so the runtime can reopen the session',
    ).toBe(true);
    expect(
      (backend as unknown as { connection: unknown }).connection,
      'the fallback must actually drop the dead connection',
    ).toBeNull();
  }, 20_000);

  it('does not report disposal as a recoverable force-close', async () => {
    const backend = createBackend();
    installPeer(backend, { prompt: async () => ({ stopReason: 'end_turn' }), cancel: async () => ({}) });
    await backend.dispose();
    expect(
      backend.isProviderConnectionForceClosed(),
      'disposal is terminal and must never invite a reopen',
    ).toBe(false);
  });
});

describe('ACP runtime provider connection liveness forwarding', () => {
  /**
   * The runtime forwarder is gated on its own `sessionId`, so a backend flag that never
   * reaches the prompt loop would make recovery dead code in production. This drives the real
   * `AcpBackend.cancel()` fallback through the real runtime accessor.
   */
  it('surfaces a real backend force-close through the started runtime', async () => {
    const backend = createBackend();
    installPeer(backend, {
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: () => new Promise<never>(() => {}),
    });

    const seam = createFakeAcpRuntimeBackend({ sessionId: 'test-session' });
    (seam as unknown as { isProviderConnectionForceClosed: () => boolean })
      .isProviderConnectionForceClosed = () => backend.isProviderConnectionForceClosed();

    const runtime = createTestAcpRuntime({
      provider: 'copilot',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides({}),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => seam,
    } as never);
    await runtime.startOrLoad({});

    expect(
      runtime.isProviderConnectionForceClosed(),
      'a healthy started session must not be reported as force-closed',
    ).toBe(false);

    await backend.cancel('test-session' as never);

    expect(
      runtime.isProviderConnectionForceClosed(),
      'the real backend force-close must reach the runtime accessor the prompt loop reads',
    ).toBe(true);
  }, 20_000);
});
