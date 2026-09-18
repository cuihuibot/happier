import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from './backendProfileSchema';
import { resolveExecutionRunProfile } from './resolveExecutionRunProfile';

const profile = AIBackendProfileSchema.parse({
  id: 'reader', name: 'Reader', defaultModelMode: 'saved-model',
  executionRunDefaults: {
    backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
    sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'reader-native', updatedAt: 1 } } },
    retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
  },
});

describe('native worker mapping resolution', () => {
  it('keeps explicit selection/lifetime above profile defaults', () => {
    expect(resolveExecutionRunProfile({
      profileId: 'READER', modelId: 'call-model', configOptions: { agent: 'explicit-native' },
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', permissionMode: 'read_only',
    }, [profile], true)).toMatchObject({
      profileId: 'reader', modelId: 'call-model', backendTargetKeys: ['agent:copilot'],
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', permissionMode: 'read_only',
      sessionConfigOptionOverrides: { overrides: { agent: { value: 'explicit-native' } } },
    });
  });
  it.each([
    { backendTarget: { kind: 'builtInAgent', agentId: 'codex' } },
    { backendTargetKeys: ['agent:copilot', 'agent:codex'] },
    { configOptions: { agent: null } },
    { configOptions: { agent: 'one' }, sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'two', updatedAt: 1 } } } },
    { permissionMode: 'not-a-permission' },
  ])('rejects invalid explicit overrides (%j)', (overrides) => {
    expect(() => resolveExecutionRunProfile({ profileId: 'reader', ...overrides }, [profile], true)).toThrow();
  });
  it('requires an exact ID for ambiguous names', () => {
    const profiles = [profile, { ...profile, id: 'second' }];
    expect(() => resolveExecutionRunProfile({ profileId: 'READER' }, profiles, false)).toThrow(/ambiguous/i);
    expect(resolveExecutionRunProfile({ profileId: 'reader' }, profiles, false).profileId).toBe('reader');
  });
  it('preserves no-profile input and plan permission defaults', () => {
    expect(resolveExecutionRunProfile({ intent: 'delegate' }, [profile], false)).toEqual({ intent: 'delegate' });
    expect(resolveExecutionRunProfile({ profileId: 'reader', intent: 'plan' }, [profile], false).permissionMode).toBe('read_only');
  });
});
