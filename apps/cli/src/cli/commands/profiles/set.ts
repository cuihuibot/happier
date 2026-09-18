import {
  AIBackendProfileSchema,
  CodingPromptBehaviorOverrideV1Schema,
  ConnectedServiceBindingsV1Schema,
  parseBackendTargetKey,
  buildBackendTargetKey,
  resolveBackendProfile,
  resolveExecutionRunProfile,
  type AIBackendProfile,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { readCredentials } from '@/persistence';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';

const valueFlags = [
  '--name', '--backend', '--config-options', '--model', '--permission-mode',
  '--run-class', '--retention', '--io-mode', '--connected-services', '--delegation-routing',
] as const;
const ConfigOptionsSchema = z.record(z.string().min(1), z.union([z.string().min(1), z.number(), z.boolean()]));
const RoutingSchema = z.enum(['native', 'happier', 'inherit']);

export function buildProfilesSettingsMutation(args: readonly string[]): (settings: Readonly<Record<string, unknown>>) => Record<string, unknown> {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json' || arg === '--account') continue;
    if (valueFlags.some((flag) => flag === arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index++;
    } else if (arg.startsWith('-')) throw new Error(`Unknown profile option: ${arg}`);
  }
  const [query, ...extra] = readCommandPositionals(args, { valueFlags });
  const account = args.includes('--account');
  if (extra.length || (account ? Boolean(query) : !query)) throw new Error('Use profiles set <id-or-name>, or --account --delegation-routing <native|happier>');
  const routingRaw = readFlagValue(args, '--delegation-routing');
  const routing = routingRaw === null ? undefined : RoutingSchema.parse(routingRaw);
  if (account && (routing === undefined || routing === 'inherit' || valueFlags.some((flag) => flag !== '--delegation-routing' && args.includes(flag)))) {
    throw new Error('Account configuration accepts only --delegation-routing native|happier');
  }
  const optionsRaw = readFlagValue(args, '--config-options');
  const options = optionsRaw === null ? undefined : ConfigOptionsSchema.parse(JSON.parse(optionsRaw));
  const connectedRaw = readFlagValue(args, '--connected-services');
  const connectedServices = connectedRaw === null ? undefined : ConnectedServiceBindingsV1Schema.parse(JSON.parse(connectedRaw));
  const timestamp = Date.now();
  return (settings) => {
    if (account) {
      const prior = z.record(z.string(), z.unknown()).parse(settings.codingPromptBehaviorV1 ?? {});
      return { ...settings, codingPromptBehaviorV1: { ...prior, delegationRouting: routing } };
    }
    const rawProfiles = z.array(z.record(z.string(), z.unknown())).parse(settings.profiles ?? []);
    const profiles = AIBackendProfileSchema.array().parse(rawProfiles);
    const resolved = resolveBackendProfile({ query, customProfiles: profiles });
    if (!resolved.ok && resolved.reason === 'ambiguous_name') throw new Error('Ambiguous profile name; use an ID');
    if (resolved.ok && resolved.profile.isBuiltIn) throw new Error('Built-in profiles are read-only; choose a new custom ID');
    const previous: AIBackendProfile | undefined = resolved.ok ? resolved.profile : undefined;
    if (!previous && !readFlagValue(args, '--name')) throw new Error('Creating a profile requires --name');
    const id = previous?.id ?? query;
    const targetRaw = readFlagValue(args, '--backend');
    const target = targetRaw ? parseBackendTargetKey(targetRaw) : previous?.executionRunDefaults?.backendTarget;
    const defaults = target ? {
      ...previous?.executionRunDefaults,
      backendTarget: target,
      ...(options ? { sessionConfigOptionOverrides: {
        v: 1, updatedAt: timestamp,
        overrides: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, { value, updatedAt: timestamp }])),
      } } : {}),
      ...(connectedServices ? { connectedServices } : {}),
      ...(readFlagValue(args, '--run-class') ? { runClass: readFlagValue(args, '--run-class') } : {}),
      ...(readFlagValue(args, '--retention') ? { retentionPolicy: readFlagValue(args, '--retention') } : {}),
      ...(readFlagValue(args, '--io-mode') ? { ioMode: readFlagValue(args, '--io-mode') } : {}),
    } : undefined;
    if (!target && (options || connectedServices || args.some((arg) => ['--run-class', '--retention', '--io-mode'].includes(arg)))) {
      throw new Error('Worker configuration requires --backend');
    }
    const permission = readFlagValue(args, '--permission-mode');
    if (permission && !target) throw new Error('Worker permission configuration requires --backend');
    const behavior = { ...previous?.codingPromptBehaviorV1 };
    if (routing === 'inherit') delete behavior.delegationRouting;
    else if (routing) behavior.delegationRouting = routing;
    const candidate = AIBackendProfileSchema.parse({
      ...previous, id,
      name: readFlagValue(args, '--name') ?? previous?.name,
      ...(readFlagValue(args, '--model') ? { defaultModelMode: readFlagValue(args, '--model') } : {}),
      ...(permission && target ? { defaultPermissionModeByTargetKey: {
        ...previous?.defaultPermissionModeByTargetKey, [buildBackendTargetKey(target)]: permission,
      } } : {}),
      ...(defaults ? { executionRunDefaults: defaults } : {}),
      ...(routing ? { codingPromptBehaviorV1: CodingPromptBehaviorOverrideV1Schema.parse(behavior) } : {}),
      updatedAt: timestamp,
    });
    if (defaults) resolveExecutionRunProfile({ profileId: candidate.id }, [candidate], false);
    const index = rawProfiles.findIndex((profile) => profile.id === candidate.id);
    const next = [...rawProfiles];
    if (index < 0) next.push(candidate);
    else next[index] = { ...rawProfiles[index], ...candidate };
    return { ...settings, profiles: next };
  };
}

export async function runProfilesSetCommand(args: string[]): Promise<void> {
  const mutate = buildProfilesSettingsMutation(args);
  const credentials = await readCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "happier auth login" first.');
  const { version } = await updateAccountSettingsV2WithRetry({ credentials, mutate });
  if (args.includes('--json')) {
    await printJsonEnvelope({ ok: true, kind: 'profiles_set', data: { settingsVersion: version, appliedToExistingSessions: false } });
  } else {
    console.log('Profile settings saved. Routing applies to newly started parents; native selection is verified at worker launch.');
  }
}
