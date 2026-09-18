import { AIBackendProfileSchema, isProfileCompatibleWithBackendTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';
import { readCredentials } from '@/persistence';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';

export async function prepareExecutionRunProfileEnv(params: Readonly<{
  profileId: string;
  backendTarget: BackendTargetRefV1;
  accountSettings: Readonly<Record<string, unknown>> | null;
}>): Promise<Record<string, string>> {
  const profiles = AIBackendProfileSchema.array().parse(params.accountSettings?.profiles ?? []);
  const profile = profiles.find((candidate) => candidate.id === params.profileId);
  if (!profile) throw new Error(`Worker profile "${params.profileId}" is no longer available`);
  if (!isProfileCompatibleWithBackendTarget(profile, params.backendTarget)) throw new Error('Worker profile is incompatible with the retained backend');
  if (profile.environmentVariables.length === 0 && profile.envVarRequirements.length === 0) return {};
  const credentials = await readCredentials();
  if (!credentials) throw new Error('Worker profile environment requires authenticated account settings');
  const result = await buildProfileEnvOverlay({
    agentId: params.backendTarget.kind === 'builtInAgent' ? params.backendTarget.agentId : params.backendTarget.backendId,
    profile, credentials, accountSettings: params.accountSettings ?? {},
    processEnv: process.env, promptSecretFn: null, startedBy: 'daemon',
  });
  return result.envOverlayExpanded;
}
