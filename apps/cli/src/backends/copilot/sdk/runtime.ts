/**
 * Copilot SDK runtime (experimental spike, host-only).
 *
 * Drives the installed GitHub Copilot CLI through the pinned
 * `@github/copilot-sdk` while delegating every host decision to the canonical
 * `createAcpRuntime` owner: transcript persistence, `task_complete` emission,
 * permission coordination, vendor-resume identity publication, pending-queue
 * draining and lifecycle cleanup all remain owned there. This module supplies
 * only the SDK-backed `AcpRuntimeBackend` through the existing `ensureBackend`
 * seam, so the spike adds no second decision-maker for any of those concepts.
 *
 * Not shipped: reachable only through the explicit experiment selection in
 * `../runtimeSelection`; ACP remains the default for every other session.
 */
import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createVendorResumeIdMetadataPublisher } from '@/session/metadata/createVendorResumeIdMetadataPublisher';
import {
  CopilotBackendIdentityError,
  persistCopilotBackendAffinity,
  readCopilotBackendAffinity,
} from '@/backends/copilot/sdk/backendAffinity';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCopilotSdkBackend } from './backend';
import type { SdkPermissionDecision } from './backend';

export { describeSdkPermissionRequest, projectNativeEvent, resolveMaxAiCredits } from './backend';
export type { SdkPermissionDecision, SdkUsageObservation } from './backend';

/** Host decision for a native permission request, from the canonical owner. */
export type HostPermissionDecision =
  | 'approved'
  | 'approved_for_session'
  | 'approved_execpolicy_amendment'
  | 'denied'
  | 'abort';

/**
 * The pinned SDK permission union has no `deny` member; a host refusal is
 * `reject`. `denied-interactively-by-user` is deliberately not used because it
 * would falsely assert that a human saw the prompt.
 *
 * Spike narrowing: session/permanent approvals are projected onto
 * `approve-once` rather than `approve-for-session`, because the latter requires
 * a typed per-category `approval` payload this vertical does not model. The
 * effect is a strictly more conservative grant, never a broader one, and it
 * never creates a durable or global approval.
 */
export function toSdkPermissionDecision(decision: HostPermissionDecision): SdkPermissionDecision {
  switch (decision) {
    case 'approved':
    case 'approved_for_session':
    case 'approved_execpolicy_amendment':
      return { kind: 'approve-once' };
    case 'denied':
      return { kind: 'reject', feedback: 'Denied by Happier permission policy' };
    case 'abort':
      return { kind: 'reject', feedback: 'Aborted by Happier permission policy' };
  }
}

export type CopilotSdkRuntimeParams = Readonly<{
  directory: string;
  /** Authoritative server resolution for this session, when the host knew it. */
  sessionLaunchOrigin?: 'created' | 'existing' | 'unknown';
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
  cliPath: string;
  model?: string;
  /** Session config/state directory; keeps spike state out of the native home. */
  configDirectory?: string;
  maxAiCredits?: number;
  /**
   * Soft observational stop after this many observed native model calls.
   *
   * Post-request accounting: it cannot prevent a call already in flight, bound
   * concurrency, or cap currency. Previously absent from this type, so the
   * configured value was silently dropped between the factory and the backend.
   */
  modelCallCeiling?: number;
  /** Explicit fixture path for the durable sanitized accounting sink. */
  usageSinkPath?: string;
  processEnv?: NodeJS.ProcessEnv;
  pendingQueueDrainMaxPopPerWake?: number;
}>;

export function createCopilotSdkRuntime(params: CopilotSdkRuntimeParams) {
  // Reuses the same durable vendor-resume identity publisher the ACP path uses,
  // so an opted-in SDK session records its native session id through the
  // existing metadata seam rather than a new wire field.
  const resumePublisher = createVendorResumeIdMetadataPublisher({
    agentId: 'copilot',
    getMetadataSnapshot: () => params.session.getMetadataSnapshot(),
    updateMetadata: (updater) => params.session.updateMetadata(updater),
  });

  /**
   * Records durable backend affinity at the moment the native session binds.
   *
   * The vendor publisher records WHICH native session to resume; it does not
   * record which transport owns it, and `copilotSessionId` is written by both
   * runtimes. Affinity is therefore persisted alongside it, at bind time rather
   * than at construction, so a session that never successfully started is not
   * durably pinned to the experimental runtime.
   */
  const persistBound = async (
    event: Readonly<{ generation: number; operation: 'create' | 'resume'; vendorSessionId: string }>,
  ): Promise<void> => {
    await resumePublisher.persistBound(event);
    await persistCopilotBackendAffinity({
      backendMode: 'sdk',
      vendorSessionId: event.vendorSessionId,
      getMetadataSnapshot: () => params.session.getMetadataSnapshot(),
      updateMetadata: (updater) => params.session.updateMetadata(updater),
    });
  };

  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: params.directory,
    happierSessionId: params.session.sessionId,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    sessionIdentity: {
      kind: 'persist-bound',
      persistBound,
      confirmVendorSessionDurable: resumePublisher.confirmVendorSessionDurable,
    },
    pendingQueue: {
      drainAfterStartOrLoad: true,
      drainDuringTurn: true,
      maxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
      inputConsumer: params.providerInputConsumer,
    },
    ensureBackend: async (): Promise<AcpRuntimeBackend> =>
      createCopilotSdkBackend({
        cliPath: params.cliPath,
        directory: params.directory,
        ...(params.model ? { model: params.model } : {}),
        ...(params.configDirectory ? { configDirectory: params.configDirectory } : {}),
        ...(params.maxAiCredits ? { maxAiCredits: params.maxAiCredits } : {}),
        ...(params.modelCallCeiling !== undefined
          ? { modelCallCeiling: params.modelCallCeiling }
          : {}),
        ...(params.usageSinkPath ? { usageSinkPath: params.usageSinkPath } : {}),
        // The host-resolved per-session environment carries HAPPIER_SESSION_ID;
        // without it the native runtime inherits ambient process.env and would
        // run native file hooks against the wrong Happier session.
        ...(params.processEnv ? { processEnv: params.processEnv } : {}),
        mcpServers: params.mcpServers,
        onPermissionRequest: async (permissionId, toolName, input) => {
          // Delegates to the canonical Happier permission owner; this runtime
          // introduces no second permission decision-maker and no local cache.
          const result = await params.permissionHandler.handleToolCall(
            permissionId,
            toolName,
            input,
          );
          return toSdkPermissionDecision(result.decision as HostPermissionDecision);
        },
      }),
  });

  // Fail-closed vendor identity for an already-bound SDK session.
  //
  // A session whose durable descriptor says `sdk` is bound to ONE native vendor
  // session. Reopening it must resume that exact id; it must never quietly
  // create a replacement, because a replacement silently discards the native
  // transcript the user is still looking at. The shared prompt loop offers a
  // create-a-new-session fallback for ordinary resume failures, so the refusal
  // is enforced here at the provider's own entry rather than by weakening the
  // shared fallback for every other provider.
  //
  // The trigger is the DURABLE affinity, never the server's launch origin. The
  // origin describes how this connection was resolved and is `unknown` against
  // an older server and `created` on a rebind, so gating on it let exactly the
  // ambiguous cases create a replacement of a live vendor session. A session
  // that is genuinely unbound has no descriptor and is unaffected; a bound one
  // is refused for every origin and regardless of the experiment flag, because
  // the binding is already persisted.
  const boundMode = readCopilotBackendAffinity(params.session.getMetadataSnapshot());
  if (boundMode !== 'sdk') return runtime;

  return {
    ...runtime,
    startOrLoad: async (opts: Parameters<typeof runtime.startOrLoad>[0] = {}): Promise<string> => {
      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (!resumeId) {
        throw new CopilotBackendIdentityError(
          'Copilot session is bound to the SDK transport and can only be reopened by resuming its ' +
            'native session; refusing to create a replacement native session.',
        );
      }
      return await runtime.startOrLoad(opts);
    },
  };
}
