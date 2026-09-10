/**
 * Durable Copilot backend affinity.
 *
 * A Copilot session must keep the runtime it actually started on. The previous
 * spike inferred affinity from `copilotSessionId`, but that field is the native
 * VENDOR resume identity and is now written by both runtimes, so a persisted SDK
 * session was misread as ACP on reopen while a legacy session that predated the
 * field could be pulled into the SDK.
 *
 * Backend transport identity is therefore recorded separately, through the
 * existing `agentRuntimeDescriptorV1` metadata owner. That envelope is already
 * provider-generic (`providerId: z.string().min(1)` with a passthrough provider
 * object), so this needs no shared schema, protocol or client change: it reuses
 * the same slot Codex, OpenCode and Pi use for their own runtime affinity.
 */
import { readAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

import type { CopilotRuntimeKind } from './runtimeSelection';

const COPILOT_PROVIDER_ID = 'copilot';

/** Backend transports a Copilot session can durably bind to. */
export type CopilotBackendMode = CopilotRuntimeKind;

/**
 * Raised when a Copilot session's persisted backend identity cannot be trusted.
 *
 * A descriptor that exists but cannot be understood is NOT the same as no
 * descriptor: treating it as absent would let a session that was durably bound
 * to one transport silently start on another. The launch is refused instead.
 */
export class CopilotBackendIdentityError extends Error {
  readonly code = 'copilot_backend_identity_unreadable';

  constructor(message: string) {
    super(message);
    this.name = 'CopilotBackendIdentityError';
  }
}

/**
 * Builds the descriptor recorded for a Copilot session's backend transport.
 *
 * `vendorSessionId` remains owned by the existing vendor-resume publisher and is
 * mirrored here only as descriptive context, never as the affinity decision.
 */
export function buildCopilotAgentRuntimeDescriptor(
  params: Readonly<{ backendMode: CopilotBackendMode; vendorSessionId?: string | null }>,
): Readonly<{
  v: 1;
  providerId: typeof COPILOT_PROVIDER_ID;
  provider: { backendMode: CopilotBackendMode; vendorSessionId?: string };
}> {
  const vendorSessionId =
    typeof params.vendorSessionId === 'string' ? params.vendorSessionId.trim() : '';
  return {
    v: 1,
    providerId: COPILOT_PROVIDER_ID,
    provider: {
      backendMode: params.backendMode,
      ...(vendorSessionId ? { vendorSessionId } : {}),
    },
  };
}

/**
 * Reads the durably recorded backend transport for a Copilot session.
 *
 * Three outcomes, never two:
 *  - `null`  — no Copilot transport was ever recorded. Normal for brand-new
 *              sessions and for every session that predates the spike. Callers
 *              must not read this as "new".
 *  - value   — the recorded transport, which is authoritative.
 *  - throws  — a transport was recorded but cannot be understood. Refusing is
 *              mandatory: silently continuing would pick a transport for a
 *              session that is already bound to a different one.
 */
export function readCopilotBackendAffinity(metadata: Metadata | null): CopilotBackendMode | null {
  if (!metadata) return null;
  const raw = (metadata as Readonly<Record<string, unknown>>).agentRuntimeDescriptorV1;
  if (raw === undefined || raw === null) return null;

  // A descriptor that is present but unparseable is unreadable, not absent: the
  // shared reader collapses "wrong provider" and "malformed envelope" into the
  // same null, so the envelope is parsed first to tell those two apart.
  const envelope = readAgentRuntimeDescriptorV1(raw);
  if (!envelope) {
    throw new CopilotBackendIdentityError(
      'Copilot session has a persisted runtime descriptor that cannot be parsed; ' +
        'refusing to launch rather than choosing a transport for an already-bound session',
    );
  }
  // Another provider's affinity is legitimately not ours.
  if (envelope.providerId !== COPILOT_PROVIDER_ID) return null;

  const provider = envelope.provider as Readonly<Record<string, unknown>> | undefined;
  const backendMode = provider?.backendMode;
  if (backendMode === 'acp' || backendMode === 'sdk') return backendMode;
  throw new CopilotBackendIdentityError(
    `Copilot session has an unreadable persisted backend transport (${describeUnreadableBackendMode(backendMode)}); ` +
      'refusing to launch rather than choosing a transport for an already-bound session',
  );
}

/** Describes a rejected transport value without echoing unbounded persisted text. */
function describeUnreadableBackendMode(value: unknown): string {
  if (typeof value !== 'string') return `type ${value === null ? 'null' : typeof value}`;
  const trimmed = value.trim();
  return trimmed.length > 32 ? 'unrecognized value' : `unrecognized value "${trimmed}"`;
}

/**
 * Records the backend transport for a session that opted into the SDK runtime.
 *
 * Writing is idempotent: an unchanged descriptor performs no metadata update, so
 * reopening a session cannot churn the persisted record.
 */
export async function persistCopilotBackendAffinity(params: Readonly<{
  backendMode: CopilotBackendMode;
  vendorSessionId?: string | null;
  getMetadataSnapshot: () => Metadata | null;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
}>): Promise<void> {
  const current = params.getMetadataSnapshot();
  if (readCopilotBackendAffinity(current) === params.backendMode) return;

  const descriptor = buildCopilotAgentRuntimeDescriptor({
    backendMode: params.backendMode,
    ...(params.vendorSessionId === undefined ? {} : { vendorSessionId: params.vendorSessionId }),
  });
  await params.updateMetadata((metadata) => ({ ...metadata, agentRuntimeDescriptorV1: descriptor }));
}
