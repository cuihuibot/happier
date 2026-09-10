/**
 * Launch-origin propagation at the real create-or-load reader.
 *
 * The server already emits `resolution: 'created' | 'existing'`
 * (`registerSessionCreateOrLoadRoute.ts`), the API type already declares it and
 * `sessionsHttp` already consumes it, but the launch-path reader dropped it. A
 * transport that may only be selected for an authoritatively new session cannot
 * be decided without this signal, and inferring it from metadata (flavor,
 * vendor id, attachment) is provably wrong.
 *
 * Only the HTTP boundary is mocked here; the real ApiClient parsing runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from './api';

const mockPost = vi.fn();
const mockGet = vi.fn();

vi.mock('axios', () => ({
  default: {
    post: (...args: any[]) => mockPost(...args),
    get: (...args: any[]) => mockGet(...args),
    isAxiosError: () => false,
  },
  isAxiosError: () => false,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
    apiServerUrl: 'https://api.example.com',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

const credential = {
  token: 'token-test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};

function stubPlaintextFeatures(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
      if (url.endsWith('/v1/features')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: {},
            capabilities: {
              encryption: {
                storagePolicy: 'plaintext_only',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
              },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as any,
  );
}

function sessionRow() {
  return {
    id: 'session-1',
    tag: 'tag-1',
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    metadata: JSON.stringify({ path: '/tmp' }),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    encryptionMode: 'plain',
  };
}

async function createSessionWithResolution(resolution: unknown) {
  stubPlaintextFeatures();
  mockPost.mockImplementation(async () => ({
    data:
      resolution === undefined
        ? { session: sessionRow() }
        : { resolution, session: sessionRow() },
  }));
  const api = await ApiClient.create(credential as any);
  return api.getOrCreateSession({
    tag: 'tag-1',
    metadata: { path: '/tmp' } as any,
    state: null,
  });
}

describe('ApiClient.getOrCreateSession launch origin', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    vi.unstubAllGlobals();
  });

  it('exposes an authoritative created origin from the server response', async () => {
    const session = await createSessionWithResolution('created');
    expect(session?.launchOrigin).toBe('created');
  });

  it('exposes an authoritative existing origin from the server response', async () => {
    const session = await createSessionWithResolution('existing');
    expect(session?.launchOrigin).toBe('existing');
  });

  it('reports unknown when an older server omits the additive field', async () => {
    const session = await createSessionWithResolution(undefined);
    // Absence must never be read as "created": every pre-spike server omits it.
    expect(session?.launchOrigin).toBe('unknown');
  });

  it('reports unknown for an unparseable discriminator instead of trusting it', async () => {
    const session = await createSessionWithResolution('CREATED');
    expect(session?.launchOrigin).toBe('unknown');
  });

  it('reports unknown for a non-string discriminator', async () => {
    const session = await createSessionWithResolution(42);
    expect(session?.launchOrigin).toBe('unknown');
  });

  it('still returns the session when unrelated additive response fields are present', async () => {
    stubPlaintextFeatures();
    mockPost.mockImplementation(async () => ({
      data: {
        resolution: 'created',
        somethingNewFromAFutureServer: { nested: true },
        session: { ...sessionRow(), futureField: 'ignored' },
      },
    }));
    const api = await ApiClient.create(credential as any);
    const session = await api.getOrCreateSession({
      tag: 'tag-1',
      metadata: { path: '/tmp' } as any,
      state: null,
    });
    // Strict parsing of unrelated fields would break older/newer servers.
    expect(session?.id).toBe('session-1');
    expect(session?.launchOrigin).toBe('created');
  });
});
