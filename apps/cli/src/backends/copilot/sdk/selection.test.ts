/**
 * Copilot transport selection, PA-accepted precedence.
 *
 * Durable affinity is authoritative and outranks both origin and the opt-in
 * flag; only an authoritatively created session with no recorded affinity may
 * opt in; a malformed persisted descriptor is a visible refusal rather than a
 * silent transport switch.
 */
import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import {
  CopilotBackendIdentityError,
  readCopilotBackendAffinity,
} from './backendAffinity';
import { resolveCopilotRuntimeKind } from './runtimeSelection';

function metadataWithDescriptor(provider: unknown): Metadata {
  return {
    agentRuntimeDescriptorV1: { v: 1, providerId: 'copilot', provider },
  } as unknown as Metadata;
}

const OPT_IN = { HAPPIER_COPILOT_SDK_EXPERIMENT: '1' } as NodeJS.ProcessEnv;
const NO_OPT_IN = {} as NodeJS.ProcessEnv;

describe('resolveCopilotRuntimeKind precedence', () => {
  it('reopens SDK for a valid SDK affinity even when the opt-in flag is off', () => {
    expect(
      resolveCopilotRuntimeKind(NO_OPT_IN, {
        existingBackendAffinity: 'sdk',
        sessionLaunchOrigin: 'existing',
      }),
    ).toBe('sdk');
  });

  it('keeps ACP for a valid ACP affinity even when the opt-in flag is on', () => {
    expect(
      resolveCopilotRuntimeKind(OPT_IN, {
        existingBackendAffinity: 'acp',
        sessionLaunchOrigin: 'created',
      }),
    ).toBe('acp');
  });

  it('selects SDK only for an authoritatively created session with explicit opt-in', () => {
    expect(
      resolveCopilotRuntimeKind(OPT_IN, {
        existingBackendAffinity: null,
        sessionLaunchOrigin: 'created',
      }),
    ).toBe('sdk');
  });

  it('keeps ACP for a created session without opt-in', () => {
    expect(
      resolveCopilotRuntimeKind(NO_OPT_IN, {
        existingBackendAffinity: null,
        sessionLaunchOrigin: 'created',
      }),
    ).toBe('acp');
  });

  it('keeps ACP for an existing unbound session even with opt-in', () => {
    expect(
      resolveCopilotRuntimeKind(OPT_IN, {
        existingBackendAffinity: null,
        sessionLaunchOrigin: 'existing',
      }),
    ).toBe('acp');
  });

  it('keeps ACP for unknown origin with opt-in and explains SDK unavailability', () => {
    const diagnostics: string[] = [];
    expect(
      resolveCopilotRuntimeKind(OPT_IN, {
        existingBackendAffinity: null,
        sessionLaunchOrigin: 'unknown',
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    ).toBe('acp');
    // An old server or attach path must not be silently reported as SDK.
    expect(diagnostics.join(' ')).toMatch(/unknown/i);
  });

  it('does not treat a missing origin as created', () => {
    expect(
      resolveCopilotRuntimeKind(OPT_IN, { existingBackendAffinity: null }),
    ).toBe('acp');
  });
});

describe('readCopilotBackendAffinity fail-closed parsing', () => {
  it('returns null when no Copilot descriptor was ever written', () => {
    expect(readCopilotBackendAffinity({} as Metadata)).toBeNull();
    expect(readCopilotBackendAffinity(null)).toBeNull();
  });

  it('reads a valid recorded transport', () => {
    expect(readCopilotBackendAffinity(metadataWithDescriptor({ backendMode: 'sdk' }))).toBe('sdk');
    expect(readCopilotBackendAffinity(metadataWithDescriptor({ backendMode: 'acp' }))).toBe('acp');
  });

  it('refuses a present-but-unknown transport instead of collapsing it to absent', () => {
    expect(() =>
      readCopilotBackendAffinity(metadataWithDescriptor({ backendMode: 'grpc' })),
    ).toThrow(CopilotBackendIdentityError);
  });

  it('refuses a present-but-malformed transport value', () => {
    expect(() =>
      readCopilotBackendAffinity(metadataWithDescriptor({ backendMode: 42 })),
    ).toThrow(CopilotBackendIdentityError);
  });

  it('refuses a Copilot descriptor that records no transport at all', () => {
    // The envelope is already filtered to providerId 'copilot', so an empty
    // provider object is OUR record, unreadable. Reading it as "absent" would
    // let an already-bound session start on the other transport.
    expect(() =>
      readCopilotBackendAffinity(metadataWithDescriptor({ vendorSessionId: 'v1' })),
    ).toThrow(CopilotBackendIdentityError);
    expect(() => readCopilotBackendAffinity(metadataWithDescriptor({}))).toThrow(
      CopilotBackendIdentityError,
    );
  });

  it('refuses a descriptor whose envelope cannot be parsed at all', () => {
    // An unsupported envelope version is present-but-unreadable, not absent.
    for (const descriptor of [
      { v: 2, providerId: 'copilot', provider: { backendMode: 'sdk' } },
      { v: 1, providerId: 'copilot' },
      'not-an-object',
    ]) {
      expect(() =>
        readCopilotBackendAffinity({ agentRuntimeDescriptorV1: descriptor } as unknown as Metadata),
      ).toThrow(CopilotBackendIdentityError);
    }
  });

  it('ignores a well-formed descriptor owned by a different provider', () => {
    // Another provider's affinity is not ours to refuse.
    expect(
      readCopilotBackendAffinity({
        agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'sdk' } },
      } as unknown as Metadata),
    ).toBeNull();
  });
});
