import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createDeferred } from '@/testkit/async/deferred';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient } from '@/testkit/backends/sessionFixtures';

import { createAcpRuntime, type AcpRuntimeBackend } from '../createAcpRuntime';

function createRuntime(params: Readonly<{
  backend: AcpRuntimeBackend;
  persistBound: (event: Readonly<{
    generation: number;
    operation: 'create' | 'resume';
    vendorSessionId: string;
  }>) => Promise<void>;
  confirmVendorSessionDurable?: (event: Readonly<{
    generation: number;
    vendorSessionId: string;
  }>) => Promise<void>;
  drainPending?: () => Promise<void>;
  resolveExpectedVendorSessionIdForResume?: (resumeReference: string) => string | null;
}>) {
  return createAcpRuntime({
    provider: 'qwen',
    directory: '/tmp',
    session: createBasicSessionClient(),
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => params.backend,
    sessionIdentity: {
      kind: 'persist-bound',
      persistBound: params.persistBound,
      ...(params.confirmVendorSessionDurable
        ? { confirmVendorSessionDurable: params.confirmVendorSessionDurable }
        : {}),
    },
    resolveExpectedVendorSessionIdForResume: params.resolveExpectedVendorSessionIdForResume,
    ...(params.drainPending
      ? {
          pendingQueue: {
            drainAfterStartOrLoad: true,
            inputConsumer: {
              drainPending: async () => {
                await params.drainPending?.();
                return { materialized: 0, stoppedReason: 'no_pending' as const };
              },
            },
          },
        }
      : {}),
  });
}

describe('createAcpRuntime session identity', () => {
  it('durably publishes before pending input drain and retries publication without reopening', async () => {
    const calls: string[] = [];
    const startSession = vi.fn(async () => {
      calls.push('open');
      return { sessionId: 'created-1' };
    });
    const persistBound = vi.fn()
      .mockImplementationOnce(async () => {
        calls.push('persist-failed');
        throw new Error('metadata unavailable');
      })
      .mockImplementationOnce(async () => {
        calls.push('persisted');
      });
    const backend = {
      startSession,
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound,
      drainPending: async () => { calls.push('drain'); },
    });

    await expect(runtime.startOrLoad({})).rejects.toThrow('metadata unavailable');
    expect(calls).toEqual(['open', 'persist-failed']);

    await expect(runtime.startOrLoad({})).resolves.toBe('created-1');
    expect(calls).toEqual(['open', 'persist-failed', 'persisted', 'drain']);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('rejects a load result that differs from the requested resume id', async () => {
    const persistBound = vi.fn(async () => {});
    const backend = {
      startSession: async () => ({ sessionId: 'unused' }),
      loadSession: async () => ({ sessionId: 'replacement-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({ backend, persistBound });

    await expect(runtime.startOrLoad({ resumeId: 'expected-1' })).rejects.toMatchObject({
      code: 'ACP_SESSION_IDENTITY_RESUME_MISMATCH',
    });
    expect(runtime.getSessionId()).toBeNull();
    expect(persistBound).not.toHaveBeenCalled();
  });

  it('keeps strict identity validation when a provider maps an opaque resume reference to its vendor id', async () => {
    const resumeReference = '/tmp/pi/sessions/2026-07-12T00-00-00_pi-session-1.jsonl';
    const persistBound = vi.fn(async () => {});
    const loadSession = vi.fn(async (_reference: string, _options?: unknown) => ({ sessionId: 'pi-session-1' }));
    const backend = {
      startSession: async () => ({ sessionId: 'unused' }),
      loadSession,
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound,
      resolveExpectedVendorSessionIdForResume: (reference) =>
        reference === resumeReference ? 'pi-session-1' : null,
    });

    await expect(runtime.startOrLoad({ resumeId: resumeReference })).resolves.toBe('pi-session-1');
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(loadSession.mock.calls[0]?.[0]).toBe(resumeReference);
    expect(persistBound).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'resume',
      vendorSessionId: 'pi-session-1',
    }));
  });

  it('opens and persists once for concurrent equal create intents', async () => {
    const opened = createDeferred<{ sessionId: string }>();
    const startSession = vi.fn(() => opened.promise);
    const persistBound = vi.fn(async () => {});
    const backend = {
      startSession,
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({ backend, persistBound });

    const first = runtime.startOrLoad({});
    const second = runtime.startOrLoad({ resumeId: null });
    await vi.waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1);
    });

    opened.resolve({ sessionId: 'created-1' });
    await expect(Promise.all([first, second])).resolves.toEqual(['created-1', 'created-1']);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(persistBound).toHaveBeenCalledTimes(1);
  });

  it('invalidates an in-flight open before backend disposal during reset', async () => {
    const calls: string[] = [];
    const opened = createDeferred<{ sessionId: string }>();
    const persistBound = vi.fn(async () => { calls.push('persist'); });
    const backend = {
      startSession: () => opened.promise,
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => { calls.push('dispose'); },
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({ backend, persistBound });

    const opening = runtime.startOrLoad({});
    const resetting = runtime.reset();
    opened.resolve({ sessionId: 'stale-1' });

    await expect(opening).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_STALE_GENERATION' });
    await resetting;
    expect(calls).toEqual(['dispose']);
    expect(runtime.getSessionId()).toBeNull();
  });

  it('fences post-publication startup work that completes after reset', async () => {
    const drain = createDeferred<void>();
    const drainStarted = createDeferred<void>();
    const backend = {
      startSession: async () => ({ sessionId: 'created-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound: async () => {},
      drainPending: async () => {
        drainStarted.resolve(undefined);
        await drain.promise;
      },
    });

    const opening = runtime.startOrLoad({});
    await drainStarted.promise;

    let resetSettled = false;
    const resetting = runtime.reset().then(() => { resetSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resetSettled).toBe(false);
    await expect(runtime.startOrLoad({})).rejects.toMatchObject({
      code: 'ACP_SESSION_IDENTITY_RESET_REQUIRED',
    });

    drain.resolve(undefined);

    await expect(opening).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_STALE_GENERATION' });
    await resetting;
    expect(runtime.getSessionId()).toBeNull();
  });

  it('waits for an in-flight deferred pending drain before reset completes', async () => {
    const drain = createDeferred<void>();
    const drainStarted = createDeferred<void>();
    const backend = {
      startSession: async () => ({ sessionId: 'created-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound: async () => {},
      drainPending: async () => {
        drainStarted.resolve(undefined);
        await drain.promise;
      },
    });

    await runtime.startOrLoad({ deferPendingDrain: true });
    const draining = runtime.drainPendingAfterStartOrLoad();
    await drainStarted.promise;

    let resetSettled = false;
    const resetting = runtime.reset().then(() => { resetSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resetSettled).toBe(false);

    drain.resolve(undefined);
    await expect(draining).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_STALE_GENERATION' });
    await resetting;
    expect(runtime.getSessionId()).toBeNull();
  });

  it('single-flights concurrent resets so the backend is disposed once', async () => {
    const disposeFinished = createDeferred<void>();
    const dispose = vi.fn(() => disposeFinished.promise);
    const backend = {
      startSession: async () => ({ sessionId: 'created-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose,
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({ backend, persistBound: async () => {} });

    await runtime.startOrLoad({});
    const firstReset = runtime.reset();
    const secondReset = runtime.reset();

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
    });
    disposeFinished.resolve(undefined);

    await expect(Promise.all([firstReset, secondReset])).resolves.toEqual([undefined, undefined]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps an opened session bound when the post-open pending drain fails', async () => {
    const calls: string[] = [];
    const startSession = vi.fn(async () => {
      calls.push('open');
      return { sessionId: 'created-1' };
    });
    const backend = {
      startSession,
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound: async () => { calls.push('persisted'); },
      drainPending: async () => {
        calls.push('drain-failed');
        throw new Error('pending drain unavailable');
      },
    });

    // The vendor session is open and its identity is durable. A pending-delivery
    // failure afterwards must not be reported to callers as a session-open failure,
    // otherwise a resume is discarded and the queued message is left stranded.
    await expect(runtime.startOrLoad({})).resolves.toBe('created-1');
    expect(calls).toEqual(['open', 'persisted', 'drain-failed']);
    expect(runtime.getSessionId()).toBe('created-1');
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('confirms vendor session durability at the first completed turn boundary', async () => {
    const confirmVendorSessionDurable = vi.fn(async () => {});
    const backend = {
      startSession: async () => ({ sessionId: 'created-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound: async () => {},
      confirmVendorSessionDurable,
    });

    await runtime.startOrLoad({});
    expect(confirmVendorSessionDurable).not.toHaveBeenCalled();

    runtime.beginTurn();
    await runtime.sendPrompt('hello');
    await runtime.flushTurn();

    expect(confirmVendorSessionDurable).toHaveBeenCalledWith({
      generation: 0,
      vendorSessionId: 'created-1',
    });
  });

  it('does not confirm vendor session durability after an explicit cancellation', async () => {
    const confirmVendorSessionDurable = vi.fn(async () => {});
    const backend = {
      startSession: async () => ({ sessionId: 'created-1' }),
      sendPrompt: async () => {},
      cancel: async () => {},
      onMessage: () => {},
      dispose: async () => {},
    } satisfies AcpRuntimeBackend;
    const runtime = createRuntime({
      backend,
      persistBound: async () => {},
      confirmVendorSessionDurable,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    await runtime.cancel();
    await runtime.flushTurn();

    expect(confirmVendorSessionDurable).not.toHaveBeenCalled();
  });
});
