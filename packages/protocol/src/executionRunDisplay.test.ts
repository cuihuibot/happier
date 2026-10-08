import { describe, expect, it } from 'vitest';

import { resolveExecutionRunDisplayTitle } from './executionRunDisplay';

describe('execution-run display identity', () => {
  it.each([
    { display: { title: ' Caller ', participantLabel: 'Participant' }, nativeSelection: { agentId: 'native', verification: 'provider_acknowledged' }, expected: 'Caller' },
    { display: { participantLabel: 'Participant' }, expected: 'Participant' },
    { nativeSelection: { agentId: 'specialist', verification: 'provider_acknowledged' }, expected: 'specialist' },
    { nativeSelection: { agentId: 'requested-only' }, expected: null },
    { nativeSelection: { agentId: 'codex', verification: 'provider_acknowledged' }, backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, expected: null },
    { nativeSelection: { agentId: 'custom', verification: 'provider_acknowledged' }, backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom' }, expected: null },
    { display: { title: ' '.repeat(200) }, expected: null },
    { display: { title: 'x'.repeat(201) }, expected: null },
    { display: null, expected: null },
  ])('resolves only explicit display or acknowledged specialist identity (%j)', ({ expected, ...run }) => {
    expect(resolveExecutionRunDisplayTitle(run)).toBe(expected);
  });
});
