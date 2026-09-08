import { AGENTS_CORE, vendorResumeIdRequiresPersistedTurn, type AgentId } from '@happier-dev/agents';

import type { AcpBoundSessionIdentity } from '@/agent/acp/runtime/sessionIdentityBinding';
import type { Metadata } from '@/api/types';

/** The manifest-owned metadata slot for this Agent's native resume identity. */
export function resolveVendorResumeIdMetadataField(agentId: AgentId): string {
  const resume = AGENTS_CORE[agentId].resume;
  const field = 'vendorResumeIdField' in resume && typeof resume.vendorResumeIdField === 'string'
    ? resume.vendorResumeIdField.trim()
    : '';
  if (!field) {
    throw new Error(`Agent ${agentId} does not declare a vendor resume metadata field`);
  }
  return field;
}

export function createVendorResumeIdMetadataPublisher(params: Readonly<{
  agentId: AgentId;
  getMetadataSnapshot: () => Metadata | null;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
}>) {
  const metadataField = resolveVendorResumeIdMetadataField(params.agentId);
  const requiresPersistedTurn = vendorResumeIdRequiresPersistedTurn(params.agentId);
  let published: Readonly<{ generation: number; vendorSessionId: string }> | null = null;
  let deferred: Readonly<{ generation: number; vendorSessionId: string }> | null = null;
  let inFlight: Readonly<{
    generation: number;
    vendorSessionId: string;
    promise: Promise<void>;
  }> | null = null;

  const writeBound = async (event: AcpBoundSessionIdentity, vendorSessionId: string): Promise<void> => {
    if (published?.generation === event.generation && published.vendorSessionId === vendorSessionId) return;

    const metadataSnapshot = params.getMetadataSnapshot();
    const persistedResumeId = metadataSnapshot
      ? (metadataSnapshot as unknown as Readonly<Record<string, unknown>>)[metadataField]
      : undefined;
    // A metadata-backed resume already has the durability that creation must establish. Requiring
    // a redundant server acknowledgement here can turn a successful provider load into a fresh
    // session fallback; non-durable resume sources still take the acknowledged write path below.
    if (
      event.operation === 'resume'
      && typeof persistedResumeId === 'string'
      && persistedResumeId.trim() === vendorSessionId
    ) {
      published = { generation: event.generation, vendorSessionId };
      return;
    }

    if (inFlight) {
      if (inFlight.generation === event.generation && inFlight.vendorSessionId === vendorSessionId) {
        return await inFlight.promise;
      }
      await inFlight.promise;
      if (published?.generation === event.generation && published.vendorSessionId === vendorSessionId) return;
    }

    const promise = Promise.resolve(params.updateMetadata((metadata) => ({
      ...metadata,
      [metadataField]: vendorSessionId,
    })));
    inFlight = { generation: event.generation, vendorSessionId, promise };
    try {
      await promise;
      published = { generation: event.generation, vendorSessionId };
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  };

  const persistBound = async (event: AcpBoundSessionIdentity): Promise<void> => {
    const vendorSessionId = typeof event.vendorSessionId === 'string'
      ? event.vendorSessionId.trim()
      : '';
    if (!vendorSessionId) {
      throw new Error('Cannot publish an empty bound vendor session identity');
    }

    // A freshly created vendor session is not yet a usable resume target for
    // Agents that only materialize one after the first persisted turn. Recording
    // it now would both advertise a target the Agent rejects and destroy the
    // previously published id that is still resumable.
    if (requiresPersistedTurn && event.operation === 'create') {
      deferred = { generation: event.generation, vendorSessionId };
      return;
    }

    if (deferred && event.generation >= deferred.generation) {
      deferred = null;
    }
    await writeBound(event, vendorSessionId);
  };

  /**
   * Report that the bound vendor session has persisted a turn and is therefore a
   * usable resume target. Ignored unless it names the exact deferred binding.
   */
  const confirmVendorSessionDurable = async (event: Readonly<{
    generation: number;
    vendorSessionId: string;
  }>): Promise<void> => {
    const vendorSessionId = typeof event.vendorSessionId === 'string' ? event.vendorSessionId.trim() : '';
    const pending = deferred;
    if (!pending || !vendorSessionId) return;
    if (pending.generation !== event.generation || pending.vendorSessionId !== vendorSessionId) return;
    await writeBound({ generation: event.generation, operation: 'create', vendorSessionId }, vendorSessionId);
    // Only a confirmed publication may retire the binding, and only the binding that was
    // actually published: the runtime treats a failed publication as non-fatal, so clearing
    // early would strand the durable id, and a generation that superseded this one while the
    // write was open still needs its own confirmation.
    if (deferred === pending) {
      deferred = null;
    }
  };

  /**
   * Remove the durable resume projection for a provider session that must never be resumed
   * again, such as one retired because cancellation could not stop its autonomous work.
   *
   * This is a compare-and-clear: only the named id is removed. After a retirement the same
   * Happier session immediately opens a *fresh* provider session, and that replacement still
   * has to be publishable, so an unconditional clear would either race the replacement or
   * destroy a healthy resume target. A deferred binding for the same id is dropped too,
   * because publishing it later would restore exactly the projection being invalidated.
   *
   * Write failures propagate. A caller that reports cancellation as complete while a resumable
   * pointer to the cancelled work survives on disk would be reporting a state that does not
   * exist.
   */
  const invalidateBound = async (vendorSessionId: string): Promise<void> => {
    const target = typeof vendorSessionId === 'string' ? vendorSessionId.trim() : '';
    if (!target) return;

    if (inFlight) {
      // Let an open write land first, otherwise the clear can be silently overwritten by it.
      await inFlight.promise.catch(() => {});
    }
    if (deferred?.vendorSessionId === target) deferred = null;

    const metadataSnapshot = params.getMetadataSnapshot();
    const persistedResumeId = metadataSnapshot
      ? (metadataSnapshot as unknown as Readonly<Record<string, unknown>>)[metadataField]
      : undefined;
    const persistedMatches = typeof persistedResumeId === 'string' && persistedResumeId.trim() === target;
    if (published?.vendorSessionId === target) published = null;
    if (!persistedMatches) return;

    await Promise.resolve(params.updateMetadata((metadata) => {
      const current = (metadata as unknown as Readonly<Record<string, unknown>>)[metadataField];
      // Re-check against the updater's own view: a concurrent publication may have replaced the
      // retired id with the fresh session between the snapshot read and this update.
      if (typeof current !== 'string' || current.trim() !== target) return metadata;
      const next = { ...(metadata as unknown as Record<string, unknown>) };
      delete next[metadataField];
      return next as typeof metadata;
    }));
  };

  return { persistBound, confirmVendorSessionDurable, invalidateBound };
}
