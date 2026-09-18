import { z } from 'zod';

import { buildBackendTargetKey, BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { mergeSpawnConfigOptionAliases } from '../actions/sessionSpawnConfigOptions.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from '../actions/executionRunActionPermissionMode.js';
import { resolvePermissionPrivilegeOrdinal } from '../actions/permissionPrivilege.js';
import { AcpConfigOptionOverridesV1Schema } from '../sessionMetadata/metadataOverridesV1.js';
import { type AIBackendProfile } from './backendProfileSchema.js';
import { resolveBackendProfile } from './resolveBackendProfile.js';
import { isProfileCompatibleWithBackendTarget } from './profileCompatibility.js';

const ExplicitConfigSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** Resolve before action defaults and permission admission; never re-default a retained run. */
export function resolveExecutionRunProfile(
  input: Readonly<Record<string, unknown>>,
  profiles: readonly AIBackendProfile[],
  fanout: boolean,
): Record<string, unknown> {
  if (input.profileId == null) return { ...input };
  if (typeof input.profileId !== 'string' || !input.profileId.trim()) throw new Error('A nonempty worker profile ID or name is required');
  const result = resolveBackendProfile({ query: input.profileId, customProfiles: profiles });
  if (!result.ok) {
    throw new Error(result.reason === 'ambiguous_name'
      ? `Ambiguous worker profile: ${result.candidates.map((candidate) => candidate.id).join(', ')}. Use an ID.`
      : `Unknown worker profile: ${input.profileId}`);
  }
  const profile = result.profile;
  const defaults = profile.executionRunDefaults;
  if (!defaults) throw new Error(`Profile "${profile.id}" has no native worker mapping`);
  const target = BackendTargetRefSchema.parse(input.backendTarget ?? defaults.backendTarget);
  const key = buildBackendTargetKey(target);
  if (key !== buildBackendTargetKey(defaults.backendTarget) || !isProfileCompatibleWithBackendTarget(profile, target)) {
    throw new Error(`Worker profile "${profile.id}" is incompatible with ${key}`);
  }
  if (fanout && input.backendTargetKeys !== undefined) {
    const keys = z.array(z.string()).parse(input.backendTargetKeys);
    if (keys.length !== 1 || keys[0] !== key) throw new Error('A native worker profile selects exactly one compatible backend');
  }
  const explicit = mergeSpawnConfigOptionAliases({
    sessionConfigOptionOverrides: input.sessionConfigOptionOverrides === undefined
      ? null : AcpConfigOptionOverridesV1Schema.parse(input.sessionConfigOptionOverrides),
    configOptions: input.configOptions === undefined ? null : ExplicitConfigSchema.parse(input.configOptions),
  });
  if (!explicit.ok) throw new Error('configOptions must agree with sessionConfigOptionOverrides');
  const overrides = { ...defaults.sessionConfigOptionOverrides.overrides, ...explicit.value?.overrides };
  const mappedIds = Object.keys(defaults.sessionConfigOptionOverrides.overrides);
  if (mappedIds.length === 0 || mappedIds.some((id) => overrides[id]?.value == null)) {
    throw new Error('A native worker mapping requires nonempty, uncleared native selection options');
  }
  const modelId = input.modelId ?? profile.defaultModelMode;
  const permissionMode = input.permissionMode
    ?? profile.defaultPermissionModeByTargetKey[key]
    ?? (target.kind === 'builtInAgent' ? profile.defaultPermissionModeByAgent[target.agentId] : undefined)
    ?? profile.defaultPermissionMode;
  const normalizedPermission = permissionMode === undefined ? undefined
    : EXECUTION_RUN_ACTION_PERMISSION_MODES.find((mode) =>
      resolvePermissionPrivilegeOrdinal(mode) === resolvePermissionPrivilegeOrdinal(permissionMode));
  if (permissionMode !== undefined && !normalizedPermission) throw new Error('Unsupported worker permission mode');
  const canonical: Record<string, unknown> = {
    permissionMode: input.intent === 'plan' ? 'read_only' : 'workspace_write',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    ...defaults,
    ...(modelId ? { modelId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    ...(normalizedPermission ? { permissionMode: normalizedPermission } : {}),
    profileId: profile.id,
    backendTarget: target,
    ...(fanout ? { backendTargetKeys: [key] } : {}),
    sessionConfigOptionOverrides: {
      v: 1,
      updatedAt: Math.max(defaults.sessionConfigOptionOverrides.updatedAt, explicit.value?.updatedAt ?? 0),
      overrides,
    },
  };
  // Alias conflicts were validated above; only the canonical representation travels to the host.
  const { configOptions: _alias, ...resolved } = canonical;
  return resolved;
}
