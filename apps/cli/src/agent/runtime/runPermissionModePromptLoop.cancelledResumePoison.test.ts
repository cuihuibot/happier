import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionMode } from '@/api/types';

import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';

/**
 * Repair coverage for the cancelled-work resurrection observed live on native v7.
 *
 * Retiring the provider connection stops a cancelled autonomous job from *delivering* anything,
 * but the provider keeps that unfinished job inside its own session state. In Happier session
 * `cmtsvfryu0kr1npp8gwyeqpw5` the recovery resumed the same provider session id
 * (`session/load 660b6e3e-a8e6-42d4-bb05-870f5359e7d8`), the provider restored the cancelled
 * instruction, answered the new prompt, and then opened a fresh continuation that re-ran the
 * whole cancelled plan with brand-new tool call ids.
 *
 * The recovery must therefore open a *fresh* provider session after that specific cancellation,
 * while every other force-close keeps the round-4 reset-and-resume behaviour.
 */

const VENDOR_SESSION_ID = 'vendor-session-660b6e3e';

function createModeQueue() {
  return new MessageQueue2<
    { permissionMode: PermissionMode; appendSystemPrompt?: string | null },
    PermissionModeQueuedPrompt
  >((mode) => mode.permissionMode, {
    batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
  });
}

async function runRecoveryAfterRetirement(resumePoisoned: boolean): Promise<{
  recoveryOpens: Array<{ resumeId?: string } | undefined>;
}> {
  const queue = createModeQueue();
  queue.push(
    { text: 'first user message', localId: 'local-1' },
    { permissionMode: 'default' },
    { userMessageLocalId: 'local-1' },
  );

  let metadata: Record<string, any> = { permissionMode: 'default', permissionModeUpdatedAt: 0 };
  let sendCount = 0;
  let forceClosed = false;
  let shouldExit = false;
  const startOrLoad = vi.fn(async (_options?: { resumeId?: string }) => undefined);

  const runtime = {
    beginTurn: vi.fn(),
    startOrLoad,
    sendPrompt: vi.fn(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        // The user cancels the autonomous continuation, which retires the connection because
        // ACP cannot cancel provider-autonomous work.
        forceClosed = true;
      }
    }),
    failTurn: vi.fn(async () => true),
    flushTurn: vi.fn(async () => undefined),
    reset: vi.fn(async () => { forceClosed = false; }),
    getSessionId: vi.fn(() => VENDOR_SESSION_ID),
    isProviderConnectionForceClosed: vi.fn(() => forceClosed),
    isProviderSessionResumePoisoned: vi.fn(() => resumePoisoned),
  };

  const session = {
    getMetadataSnapshot: () => metadata,
    updateMetadata: (updater: (current: typeof metadata) => typeof metadata) => {
      metadata = updater(metadata);
    },
    ensureMetadataSnapshot: async () => metadata,
    waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
    waitForPendingEligibilityUpdate: () => new Promise<void>(() => {}),
    fetchLatestUserPermissionIntentFromTranscript: async () => null,
    sendAgentMessage: vi.fn(),
  };

  await runPermissionModePromptLoop({
    providerName: 'Copilot',
    agentMessageType: 'copilot',
    explicitPermissionMode: 'default',
    session: session as any,
    messageQueue: queue,
    permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
    runtime: runtime as any,
    createOverrideSynchronizer: () => ({
      syncFromMetadata: () => {},
      flushPendingAfterStart: async () => {},
    }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => new AbortController().signal,
    keepAlive: () => {},
    setThinking: () => {},
    sendReady: () => {
      if (sendCount === 1) {
        queue.push(
          { text: 'next user message', localId: 'local-2' },
          { permissionMode: 'default' },
          { userMessageLocalId: 'local-2' },
        );
        return;
      }
      shouldExit = true;
    },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => {},
    setCurrentPermissionModeUpdatedAt: () => {},
    formatPromptErrorMessage: (error: unknown) => String(error),
  } as never);

  // The first open is the ordinary session start; everything after it is the recovery.
  const recoveryOpens = startOrLoad.mock.calls.map(([options]) => options).slice(1);
  return { recoveryOpens };
}

describe('prompt loop recovery after cancelling uncancellable provider work', () => {
  it('opens a fresh provider session instead of resuming the poisoned one', async () => {
    const { recoveryOpens } = await runRecoveryAfterRetirement(true);

    expect(
      recoveryOpens.length,
      'the recovery must still reopen, so the Happier session stays usable',
    ).toBeGreaterThan(0);
    for (const options of recoveryOpens) {
      expect(
        options?.resumeId ?? null,
        'resuming the poisoned provider session re-runs the cancelled autonomous plan',
      ).toBeNull();
    }
  });

  it('still resumes the provider session for an ordinary force-close', async () => {
    const { recoveryOpens } = await runRecoveryAfterRetirement(false);

    expect(recoveryOpens.length).toBeGreaterThan(0);
    expect(
      recoveryOpens.some((options) => options?.resumeId === VENDOR_SESSION_ID),
      'an unresponsive-process force-close keeps the round-4 reset-and-resume recovery',
    ).toBe(true);
  });
});
