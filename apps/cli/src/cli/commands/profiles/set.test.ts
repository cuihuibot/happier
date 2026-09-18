import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema, resolveExecutionRunProfile } from '@happier-dev/protocol';
import { buildProfilesSettingsMutation } from './set';

describe('CLI saved worker configuration', () => {
  it('saves a named mapping, reloads it and resolves a managed launch without losing unrelated settings', () => {
    const mutate = buildProfilesSettingsMutation([
      'worker', '--name', 'Reviewer', '--backend', 'agent:copilot',
      '--config-options', '{"agent":"reviewer"}', '--model', 'model-a',
      '--permission-mode', 'read-only', '--run-class', 'long_lived', '--retention', 'resumable',
    ]);
    const settings = mutate({ unrelated: { retained: true }, profiles: [] });
    expect(settings.unrelated).toEqual({ retained: true });
    const profiles = AIBackendProfileSchema.array().parse(JSON.parse(JSON.stringify(settings.profiles)));
    expect(resolveExecutionRunProfile({ profileId: 'reviewer' }, profiles, false)).toMatchObject({
      profileId: 'worker', modelId: 'model-a', permissionMode: 'read_only',
      runClass: 'long_lived', retentionPolicy: 'resumable',
      sessionConfigOptionOverrides: { overrides: { agent: { value: 'reviewer' } } },
    });
    const update = buildProfilesSettingsMutation(['worker', '--model', 'model-b']);
    const revised = update({ ...settings, concurrentField: 42 });
    expect(revised.concurrentField).toBe(42);
    expect(AIBackendProfileSchema.array().parse(revised.profiles)[0].executionRunDefaults)
      .toEqual(profiles[0].executionRunDefaults);
  });

  it('keeps account routing and optional parent override independent', () => {
    const account = buildProfilesSettingsMutation(['--account', '--delegation-routing', 'happier'])({});
    const parent = buildProfilesSettingsMutation(['parent', '--name', 'Parent'])(account);
    expect(parent.codingPromptBehaviorV1).toMatchObject({ delegationRouting: 'happier' });
    expect(AIBackendProfileSchema.array().parse(parent.profiles)[0].codingPromptBehaviorV1?.delegationRouting).toBeUndefined();
    const override = buildProfilesSettingsMutation(['parent', '--delegation-routing', 'native'])(parent);
    const inherited = buildProfilesSettingsMutation(['parent', '--delegation-routing', 'inherit'])(override);
    expect(AIBackendProfileSchema.array().parse(inherited.profiles)[0].codingPromptBehaviorV1?.delegationRouting).toBeUndefined();
  });

  it('rejects invalid flags, malformed options and empty native mappings', () => {
    expect(() => buildProfilesSettingsMutation(['worker', '--api-key', 'do-not-store'])).toThrow();
    expect(() => buildProfilesSettingsMutation(['worker', '--config-options', '{bad'])).toThrow();
    expect(() => buildProfilesSettingsMutation(['worker', '--backend', 'agent:copilot', '--config-options', '{}'])({})).toThrow();
  });
  it('rejects an invalid explicit backend rather than silently saving an unmapped profile', () => {
    expect(() => buildProfilesSettingsMutation(['new', '--name', 'New', '--backend', 'not-a-target'])({})).toThrow(/backend/i);
  });
});
