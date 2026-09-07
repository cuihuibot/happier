import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from './manifest';
import { resolveAgentVendorResumeIdDurability } from './resumeDurability';

describe('vendor resume id durability', () => {
  it('defaults to session-open durability for Agents that do not declare otherwise', () => {
    expect(AGENTS_CORE.qwen.resume.vendorResumeIdDurability).toBeUndefined();
    expect(resolveAgentVendorResumeIdDurability('qwen')).toBe('at-session-open');
  });

  it('declares that a Copilot vendor session only becomes resumable after its first persisted turn', () => {
    expect(AGENTS_CORE.copilot.resume.vendorResumeIdDurability).toBe('after-first-persisted-turn');
    expect(resolveAgentVendorResumeIdDurability('copilot')).toBe('after-first-persisted-turn');
  });
});
