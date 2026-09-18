import { describe, expect, it } from 'vitest';
import { createExecutionRunBackend } from './createExecutionRunBackend';

describe('managed native profile capability admission', () => {
  it('rejects a backend without a provider-owned named-native selection adapter', () => {
    expect(() => createExecutionRunBackend({
      backendId: 'customAcp', backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom' },
      cwd: process.cwd(), permissionMode: 'read_only', start: { profileId: 'saved-native' },
      accountSettings: {},
    })).toThrow(/native.*selection/i);
  });
});
