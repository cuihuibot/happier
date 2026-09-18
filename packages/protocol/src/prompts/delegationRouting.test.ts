import { describe, expect, it } from 'vitest';

import { AIBackendProfileSchema } from '../profiles/backendProfileSchema.js';
import { applyCodingPromptBehaviorOverrideToSettings } from './codingPromptBehaviorV1.js';
import { buildCodingSessionPromptPlanBaseV1 } from './buildAppendSystemPromptBaseV1.js';

describe('saved parent delegation routing', () => {
  function resolve(account: unknown, override: unknown) {
    const profile = AIBackendProfileSchema.parse({
      id: 'parent', name: 'Parent', codingPromptBehaviorV1: override,
    });
    const settings = applyCodingPromptBehaviorOverrideToSettings({
      settings: { codingPromptBehaviorV1: account },
      override: profile.codingPromptBehaviorV1,
    });
    const plan = buildCodingSessionPromptPlanBaseV1({ settings, executionRunsFeatureEnabled: true });
    return { settings, block: plan.blocks.find((block) => block.id === 'coding.execution_runs') };
  }

  it('inherits account Happier routing through an unrelated parent override', () => {
    const { settings, block } = resolve({ delegationRouting: 'happier' }, { responseOptions: 'disabled' });
    expect(settings.codingPromptBehaviorV1).toMatchObject({ delegationRouting: 'happier' });
    expect(block?.text).toContain('Delegation route: Happier');
    expect(block?.text).not.toContain("Use the current backend's native subagent facility by default.");
  });

  it('lets an explicit parent native override win and preserves the native default', () => {
    expect(resolve({ delegationRouting: 'happier' }, { delegationRouting: 'native' }).block?.text)
      .toContain("Use the current backend's native subagent facility by default.");
    expect(resolve({}, {}).block?.text).toContain("Use the current backend's native subagent facility by default.");
  });

  it('does not activate guidance when the feature or guidance is disabled', () => {
    for (const feature of [false, true]) {
      const plan = buildCodingSessionPromptPlanBaseV1({
        settings: { codingPromptBehaviorV1: { delegationRouting: 'happier' }, executionRunsGuidanceEnabled: false },
        executionRunsFeatureEnabled: feature,
      });
      expect(plan.blocks.some((block) => block.id === 'coding.execution_runs')).toBe(false);
    }
  });
});
