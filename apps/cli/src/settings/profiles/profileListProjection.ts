import { AGENT_IDS } from '@happier-dev/agents';
import {
  getRequiredConfigEnvVarNames,
  getRequiredSecretEnvVarNames,
  isProfileCompatibleWithAgent,
  isProfileCompatibleWithBackendTarget,
  type AIBackendProfile,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';

export type ProfilesListItem = Readonly<{
  id: string;
  name: string;
  isBuiltIn: boolean;
  description?: string;
  supportedAgentIds: string[];
  requiredSecretEnvVarNames: string[];
  requiredConfigEnvVarNames: string[];
  authMode?: AIBackendProfile['authMode'];
  requiresMachineLoginTargetKey?: string;
  requiresMachineLogin?: string;
  workerMapping?: Readonly<{
    backendTarget: BackendTargetRefV1;
    configOptionIds: string[];
    selectionStatus: 'unverified';
  }>;
}>;

export type SpawnProfileOptionItem = ProfilesListItem & Readonly<{
  value: string;
  label: string;
  profileId: string;
  enabled: boolean;
}>;

export function mapProfileToListItem(profile: AIBackendProfile): ProfilesListItem {
  return {
    id: profile.id,
    name: profile.name,
    isBuiltIn: profile.isBuiltIn === true,
    ...(profile.description ? { description: profile.description } : {}),
    supportedAgentIds: AGENT_IDS.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId)),
    requiredSecretEnvVarNames: getRequiredSecretEnvVarNames(profile),
    requiredConfigEnvVarNames: getRequiredConfigEnvVarNames(profile),
    ...(profile.authMode ? { authMode: profile.authMode } : {}),
    ...(profile.requiresMachineLoginTargetKey ? { requiresMachineLoginTargetKey: profile.requiresMachineLoginTargetKey } : {}),
    ...(profile.requiresMachineLogin ? { requiresMachineLogin: profile.requiresMachineLogin } : {}),
    ...(profile.executionRunDefaults ? { workerMapping: {
      backendTarget: profile.executionRunDefaults.backendTarget,
      configOptionIds: Object.keys(profile.executionRunDefaults.sessionConfigOptionOverrides.overrides),
      selectionStatus: 'unverified' as const,
    } } : {}),
  };
}

export function mapProfileToSpawnOptionItem(profile: AIBackendProfile): SpawnProfileOptionItem {
  const item = mapProfileToListItem(profile);
  return {
    ...item,
    value: item.id,
    label: item.name,
    profileId: item.id,
    enabled: profile.defaultEnabled !== false,
  };
}

export function filterProfilesForSpawnOptions(params: Readonly<{
  profiles: ReadonlyArray<AIBackendProfile>;
  agentId?: string | null;
  backendTarget?: BackendTargetRefV1 | null;
  includeDisabled?: boolean;
}>): ReadonlyArray<AIBackendProfile> {
  return params.profiles.filter((profile) => {
    if (params.includeDisabled !== true && profile.defaultEnabled === false) return false;
    if (params.backendTarget && !isProfileCompatibleWithBackendTarget(profile, params.backendTarget)) return false;
    if (params.agentId && !isProfileCompatibleWithAgent(profile, params.agentId)) return false;
    return true;
  });
}
