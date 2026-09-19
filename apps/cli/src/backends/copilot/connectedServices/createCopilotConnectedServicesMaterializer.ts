import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { requireConnectedServiceTokenCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';

import { COPILOT_GITHUB_TOKEN_ENV_KEY } from '@/backends/copilot/auth/copilotGithubTokenEnv';

/**
 * Copilot consumes a connected GitHub token purely through the child environment: the CLI reads
 * `COPILOT_GITHUB_TOKEN` and keeps no Happier-owned home or credential file, so nothing is
 * materialized on disk here. Returning `null` when no GitHub profile is bound leaves the spawn on
 * Copilot's native authentication (ambient `GH_TOKEN`/`GITHUB_TOKEN` or local `gh auth token`).
 */
export function createCopilotConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const github = params.recordsByServiceId.get('github') ?? null;
    if (!github) return null;

    const record = requireConnectedServiceTokenCredentialRecord(github);

    return {
      env: { [COPILOT_GITHUB_TOKEN_ENV_KEY]: record.token.token },
      cleanupOnFailure: params.cleanupRoot,
      cleanupOnExit: null,
    };
  };
}
