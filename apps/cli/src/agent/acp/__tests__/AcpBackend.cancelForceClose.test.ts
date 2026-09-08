import { describe, expect, it } from 'vitest';
import type { PromptResponse } from '@agentclientprotocol/sdk';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';

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
