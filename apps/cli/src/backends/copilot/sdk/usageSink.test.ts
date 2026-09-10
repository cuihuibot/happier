/**
 * Durable sanitized accounting sink, proven end to end.
 *
 * An independent reviewer found that accounting existed only as an in-process
 * getter, which an external live driver cannot read: by the time the driver
 * inspects anything, the owned runtime is gone. These tests drive a real native
 * `assistant.usage` event through the backend's real transport boundary and
 * require the record to be readable from disk afterwards.
 *
 * The only mocked boundary is the pinned `@github/copilot-sdk` process adapter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCopilotSdkBackend } from './backend';
import { createSpikeScratchDir } from './spikeScratch';

const wire = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  send: vi.fn(),
  abort: vi.fn(),
  disconnect: vi.fn(),
  stop: vi.fn(),
  create: vi.fn(),
  connection: vi.fn(),
}));

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: { forStdio: wire.connection },
  CopilotClient: class {
    start = vi.fn(async () => {});
    stop = wire.stop;
    createSession = wire.create;
    resumeSession = vi.fn();
  },
}));

let fixtureRoot: string;
let removeFixtureRoot: () => void;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  // Root-bounded scratch: spike tests never write into the shared system temp.
  const scratch = createSpikeScratchDir('usage-sink');
  fixtureRoot = scratch.path;
  removeFixtureRoot = scratch.cleanup;
  wire.config = null;
  wire.create.mockImplementation(async (config: Record<string, unknown>) => {
    wire.config = config;
    return {
      sessionId: 'spike-native-session',
      send: wire.send,
      abort: wire.abort,
      disconnect: wire.disconnect,
    };
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  removeFixtureRoot();
  vi.clearAllMocks();
});

/** Opens the real native transport so `onEvent` is registered by the backend. */
async function openBackend(usageSinkPath?: string) {
  const value = createCopilotSdkBackend({
    cliPath: '/spike/never-launch',
    directory: fixtureRoot,
    ...(usageSinkPath === undefined ? {} : { usageSinkPath }),
  });
  cleanups.push(async () => {
    await value.dispose().catch(() => {});
  });
  await value.startSession();
  return value;
}

/** Emits through the exact callback the backend registered with the SDK. */
function emitUsage(data: Record<string, unknown>): void {
  const onEvent = wire.config?.onEvent;
  if (typeof onEvent !== 'function') throw new Error('native transport is not open');
  (onEvent as (event: { type: string; data: Record<string, unknown> }) => void)({
    type: 'assistant.usage',
    data,
  });
}

/** Reads the sink exactly as the external driver does: line-delimited JSON. */
function readSinkRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A realistic pinned-shape payload, including content that must not leak. */
const USAGE_DATA = {
  apiCallId: 'call-abc',
  model: 'gpt-5',
  initiator: 'sub-agent',
  interactionType: 'conversation-subagent',
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  prompt: 'SECRET PROMPT TEXT',
  messages: [{ role: 'user', content: 'SECRET USER CONTENT' }],
};

describe('sanitized usage sink', () => {
  it('stays default-off when no sink path is configured', async () => {
    const backend = await openBackend();
    emitUsage(USAGE_DATA);
    // The in-process observation still happens; durability is opt-in only.
    expect(backend.getUsageObservations()).toHaveLength(1);
    expect(() => readFileSync(join(fixtureRoot, 'usage.jsonl'), 'utf8')).toThrow();
  });

  it('durably records a native usage event an external reader can consume', async () => {
    const sinkPath = join(fixtureRoot, 'usage.jsonl');
    await openBackend(sinkPath);

    emitUsage(USAGE_DATA);

    const records = readSinkRecords(sinkPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      apiCallId: 'call-abc',
      model: 'gpt-5',
      initiator: 'sub-agent',
      interactionType: 'conversation-subagent',
      totalTokens: 120,
    });
  });

  it('never writes prompt, message or unknown payload content', async () => {
    const sinkPath = join(fixtureRoot, 'usage.jsonl');
    await openBackend(sinkPath);

    emitUsage(USAGE_DATA);

    const raw = readFileSync(sinkPath, 'utf8');
    expect(raw).not.toContain('SECRET PROMPT TEXT');
    expect(raw).not.toContain('SECRET USER CONTENT');
    // Allowlisted accounting fields only: no passthrough of arbitrary keys.
    expect(Object.keys(readSinkRecords(sinkPath)[0]!).sort()).toEqual([
      'apiCallId',
      'initiator',
      'inputTokens',
      'interactionType',
      'model',
      'observedAtMs',
      'outputTokens',
      'totalTokens',
    ]);
  });

  it('omits counters the native event did not report rather than writing zero', async () => {
    const sinkPath = join(fixtureRoot, 'usage.jsonl');
    await openBackend(sinkPath);

    emitUsage({ apiCallId: 'call-no-tokens', model: 'gpt-5' });

    const record = readSinkRecords(sinkPath)[0]!;
    expect(record).toMatchObject({ apiCallId: 'call-no-tokens' });
    // Unknown cost stays unknown; a zero would assert a free call.
    expect(record).not.toHaveProperty('totalTokens');
    expect(record).not.toHaveProperty('inputTokens');
  });

  it('appends one record per event so the count survives shutdown', async () => {
    const sinkPath = join(fixtureRoot, 'usage.jsonl');
    const backend = await openBackend(sinkPath);

    emitUsage(USAGE_DATA);
    emitUsage({ apiCallId: 'call-2', model: 'gpt-5', totalTokens: 7 });
    await backend.dispose().catch(() => {});

    // Read strictly AFTER the owned runtime was shut down. The trailing record
    // is the terminal finalization marker, which is what lets an out-of-process
    // reader tell a complete sink from a truncated prefix.
    const records = readSinkRecords(sinkPath);
    expect(records.slice(0, -1).map((record) => record.apiCallId)).toEqual(['call-abc', 'call-2']);
    expect(records.at(-1)).toMatchObject({ finalized: true, nativeCalls: 2 });
  });

  it('reports a sink write failure instead of failing silently', async () => {
    const unwritable = join(fixtureRoot, 'missing-directory', 'usage.jsonl');
    const backend = await openBackend(unwritable);

    emitUsage(USAGE_DATA);

    // Durability failed, but the failure is counted and logged, not swallowed.
    expect(backend.getUsageObservations()).toHaveLength(1);
    expect(backend.getUsageSinkFailureCount()).toBe(1);
  });
});
