import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol';
import { mapProfileToListItem } from './profileListProjection';

describe('saved worker profile listing', () => {
  it('reports configured but unverified mapping metadata without environment values', () => {
    const item = mapProfileToListItem(AIBackendProfileSchema.parse({
      id: 'reader', name: 'Reader',
      environmentVariables: [{ name: 'PRIVATE_VALUE', value: 'fixture-private-value' }],
      executionRunDefaults: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'reader', updatedAt: 1 } } },
      },
    }));
    expect(item).toMatchObject({
      workerMapping: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        configOptionIds: ['agent'], selectionStatus: 'unverified',
      },
    });
    expect(JSON.stringify(item)).not.toContain('fixture-private-value');
  });
});
