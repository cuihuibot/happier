import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  COPILOT_GITHUB_TOKEN_ENV_KEY,
  COPILOT_GITHUB_TOKEN_ENV_KEYS,
} from '@/backends/copilot/auth/copilotGithubTokenEnv';
import { getConnectedServiceMaterializer } from '@/backends/catalog';

const PLACEHOLDER_GITHUB_TOKEN = 'gho_test_placeholder_token';

async function createRootDir(): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), 'happier-copilot-base-'));
  return join(baseDir, 'launch', 'copilot');
}

async function requireCopilotMaterializer() {
  // Resolve through the catalog hook the spawn path actually calls, so the test also covers
  // the provider registration and not just the factory in isolation.
  const materializer = await getConnectedServiceMaterializer('copilot');
  if (!materializer) throw new Error('copilot has no connected-service materializer registered');
  return materializer;
}

describe('copilot connected-service materialization', () => {
  it('projects the selected GitHub token profile into the Copilot runtime token env key', async () => {
    const materializer = await requireCopilotMaterializer();
    const record = buildConnectedServiceCredentialRecord({
      now: Date.now(),
      serviceId: 'github',
      profileId: 'default',
      kind: 'token',
      token: { token: PLACEHOLDER_GITHUB_TOKEN, providerAccountId: null, providerEmail: null },
    });

    const result = await materializer({
      agentId: 'copilot',
      activeServerDir: await mkdtemp(join(tmpdir(), 'happier-copilot-active-server-')),
      rootDir: await createRootDir(),
      recordsByServiceId: new Map([['github', record]]),
      cleanupRoot: () => {},
    });

    // Bind the literal vendor-consumed key rather than only the shared constant: Copilot CLI
    // documents `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in that precedence order, so
    // the projection must write the highest-precedence key or a selected profile could be
    // shadowed by an ambient token. Renaming the constant alone must not keep this test green.
    expect(COPILOT_GITHUB_TOKEN_ENV_KEY).toBe('COPILOT_GITHUB_TOKEN');
    expect(result?.env).toEqual({ COPILOT_GITHUB_TOKEN: PLACEHOLDER_GITHUB_TOKEN });
  });

  it('keeps the selected profile ahead of an ambient GitHub token in the spawned environment', () => {
    // `gh`-facing keys stay untouched, and the written key outranks both of them.
    expect([...COPILOT_GITHUB_TOKEN_ENV_KEYS]).toEqual(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
    expect(COPILOT_GITHUB_TOKEN_ENV_KEYS[0]).toBe(COPILOT_GITHUB_TOKEN_ENV_KEY);
  });

  it('leaves native Copilot authentication untouched when no GitHub profile is selected', async () => {
    const materializer = await requireCopilotMaterializer();

    const result = await materializer({
      agentId: 'copilot',
      activeServerDir: await mkdtemp(join(tmpdir(), 'happier-copilot-active-server-')),
      rootDir: await createRootDir(),
      recordsByServiceId: new Map(),
      cleanupRoot: () => {},
    });

    expect(result).toBeNull();
  });

  it('rejects a non-token GitHub credential instead of spawning unauthenticated', async () => {
    const materializer = await requireCopilotMaterializer();
    const record = buildConnectedServiceCredentialRecord({
      now: Date.now(),
      serviceId: 'github',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: Date.now() + 60_000,
      oauth: {
        accessToken: PLACEHOLDER_GITHUB_TOKEN,
        refreshToken: 'placeholder-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(materializer({
      agentId: 'copilot',
      activeServerDir: await mkdtemp(join(tmpdir(), 'happier-copilot-active-server-')),
      rootDir: await createRootDir(),
      recordsByServiceId: new Map([['github', record]]),
      cleanupRoot: () => {},
    })).rejects.toThrow(/token credential/i);
  });
});
