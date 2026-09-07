import { AGENTS_CORE } from './manifest.js';
import type { AgentId, VendorResumeIdDurability } from './types.js';

/**
 * When an Agent's vendor resume id becomes a usable resume target.
 *
 * Agents that do not declare this are durable from session open, which is the
 * historical behavior every non-declaring Agent already relies on.
 */
export function resolveAgentVendorResumeIdDurability(agentId: AgentId): VendorResumeIdDurability {
    const resume = AGENTS_CORE[agentId].resume;
    return 'vendorResumeIdDurability' in resume && resume.vendorResumeIdDurability
        ? resume.vendorResumeIdDurability
        : 'at-session-open';
}

export function vendorResumeIdRequiresPersistedTurn(agentId: AgentId): boolean {
    return resolveAgentVendorResumeIdDurability(agentId) === 'after-first-persisted-turn';
}
