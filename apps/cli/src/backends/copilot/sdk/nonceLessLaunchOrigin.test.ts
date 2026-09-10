/**
 * Interaction regression: nonce-less spawn compatibility vs authoritative
 * SDK launch-origin selection.
 *
 * The merged custom base carries a compatibility path for released clients that
 * predate caller-supplied spawn nonces: when a provider-safe spawn arrives with
 * no `spawnNonce`, the daemon settles the launch identity itself and answers
 * with the direct `success + sessionId` shape those clients accept.
 *
 * That path makes "this launch was started by us" observable at the RPC seam,
 * which is exactly the signal an SDK opt-in must NOT be allowed to mine. The
 * authoritative create-or-load discriminator is the server's own
 * `getOrCreateSession` response; a missing nonce, a locally settled identity, a
 * fresh session id or a successful spawn are all launch *mechanics*, not
 * creation *authority*.
 *
 * These assertions run through the REAL `registerMachineRpcHandlers` seam and
 * the REAL `createCopilotRuntime` selection factory, because the defect this
 * guards against would be introduced in the composition between them, not in
 * either helper alone. The only mocked boundary is the pinned
 * `@github/copilot-sdk` transport, which is a genuine external process adapter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { Metadata } from '@/api/types';
import { createCopilotRuntime } from '@/backends/copilot/runtimeFactory';
import { resolveCopilotRuntimeKind } from '@/backends/copilot/sdk/runtimeSelection';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: { forStdio: vi.fn() },
  CopilotClient: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    createSession = vi.fn();
    resumeSession = vi.fn();
  },
}));

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

/**
 * Registers the real machine RPC handlers against an inert manager and returns
 * the provider-safe spawn entry point plus its collaborator spies.
 */
function nonceLessSpawnSeam() {
  const registered = new Map<string, (params: any) => Promise<any>>();
  const rpcHandlerManager = {
    registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
      registered.set(method, handler);
    },
  } as any;

  const spawnSession = vi.fn(async () => ({
    type: 'success' as const,
    spawnNonce: 'daemon-minted-nonce',
    sessionIdStatus: 'pending' as const,
  }));
  const resolveSpawnSessionByNonce = vi.fn(async () => ({
    status: 'success' as const,
    sessionId: 'session-settled-without-caller-nonce',
  }));

  registerMachineRpcHandlers({
    rpcHandlerManager,
    handlers: {
      spawnSession,
      resolveSpawnSessionByNonce,
      stopSession: async () => true,
      requestShutdown: () => {},
    },
  } as any);

  const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
  if (!handler) throw new Error('provider-safe spawn handler was not registered');
  return { handler, spawnSession, resolveSpawnSessionByNonce };
}

/** Builds the real Copilot runtime selection composition for one launch. */
function selectRuntime(params: {
  metadata?: Metadata;
  sessionLaunchOrigin?: 'created' | 'existing' | 'unknown';
  env?: NodeJS.ProcessEnv;
}) {
  const session = createMutableApiSessionClientFixture({
    metadata: params.metadata ?? createTestMetadata(),
  });
  const runtime = createCopilotRuntime({
    directory: '/spike/synthetic-workdir',
    machineId: 'spike-machine',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: vi.fn(),
    providerInputConsumer: inertInputConsumer,
    ...(params.sessionLaunchOrigin ? { sessionLaunchOrigin: params.sessionLaunchOrigin } : {}),
    processEnv: {
      HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
      HAPPIER_COPILOT_SDK_CLI_PATH: '/spike/never-launch',
      ...params.env,
    },
  } as Parameters<typeof createCopilotRuntime>[0]);
  return runtime;
}

describe('nonce-less spawn compatibility vs authoritative SDK launch origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settles a nonce-less provider-safe spawn without publishing any launch-origin authority', async () => {
    const { handler, resolveSpawnSessionByNonce } = nonceLessSpawnSeam();

    const result = await handler({ directory: '/tmp' });

    // The compatibility shape released clients accept: success + a real id.
    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-settled-without-caller-nonce',
    });
    expect(resolveSpawnSessionByNonce).toHaveBeenCalledWith(
      'daemon-minted-nonce',
      expect.any(Number),
    );

    // The seam must not hand any downstream consumer a create-or-load verdict.
    // Only the server's getOrCreateSession response may carry that, so the
    // absence of these keys is the contract, not an incidental detail.
    for (const forbidden of ['launchOrigin', 'sessionLaunchOrigin', 'created', 'isNew']) {
      expect(Object.hasOwn(result as object, forbidden)).toBe(false);
    }
  });

  it('refuses the SDK for a nonce-less launch whose server response omits the origin discriminator', () => {
    // A released nonce-less client is exactly the population talking to an older
    // or discriminator-free server path, which yields 'unknown'.
    const runtime = selectRuntime({ sessionLaunchOrigin: 'unknown' });
    expect(runtime.runtimeKind).toBe('acp');
  });

  it('refuses the SDK when the launch origin is absent entirely', () => {
    const runtime = selectRuntime({});
    expect(runtime.runtimeKind).toBe('acp');
  });

  it('reports why the opt-in was not honored for a nonce-less unknown-origin launch', () => {
    const diagnostics: string[] = [];
    const selected = resolveCopilotRuntimeKind(
      { HAPPIER_COPILOT_SDK_EXPERIMENT: '1' },
      {
        existingBackendAffinity: null,
        sessionLaunchOrigin: 'unknown',
        onDiagnostic: (message) => diagnostics.push(message),
      },
    );
    expect(selected).toBe('acp');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('authoritatively created');
  });

  it('still honors the SDK opt-in when the server authoritatively reports creation', () => {
    // The guard must not be satisfied by refusing everything: an authoritative
    // 'created' origin remains the one path that reaches the SDK.
    const runtime = selectRuntime({ sessionLaunchOrigin: 'created' });
    expect(runtime.runtimeKind).toBe('sdk');
  });

  it('keeps durable ACP affinity ahead of an authoritative created origin', () => {
    const runtime = selectRuntime({
      metadata: createTestMetadata({
        agentRuntimeDescriptorV1: { v: 1, providerId: 'copilot', provider: { backendMode: 'acp' } },
      } as unknown as Partial<Metadata>),
      sessionLaunchOrigin: 'created',
    });
    expect(runtime.runtimeKind).toBe('acp');
  });

  it('never lets a nonce-less settled session id stand in for creation authority', () => {
    // The settled id from the compatibility path is a launch mechanic. Feeding a
    // real session id through an 'existing' launch must stay on ACP.
    const runtime = selectRuntime({ sessionLaunchOrigin: 'existing' });
    expect(runtime.runtimeKind).toBe('acp');
  });
});
