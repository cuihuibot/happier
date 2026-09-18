import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createDeferred } from '@/testkit/async/deferred';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import { AcpPromptSubmissionPhaseError, type AcpPromptSubmissionEvidence } from '@/agent/acp/AcpBackend';
import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { isAbortLikeError, markTurnFailure } from '@/agent/executionRuns/runtime/turnDelivery';
import { ProviderPromptSubmissionRejectedBeforeEffectError } from '@/agent/runtime/providerPromptSubmission';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';

describe('createAcpRuntime Standard ACP provider-input acceptance contract', () => {
  it.each(['submission', 'completion', 'cancelled-outcome', 'submitted-callback', 'compact'] as const)(
    "does not apply a cancelled prompt's late %s settlement to its replacement",
    async (stage) => {
      const oldSubmission = createDeferred<AcpPromptSubmissionEvidence>();
      const oldCompletion = createDeferred<AcpTurnOutcome>();
      const oldCallback = createDeferred();
      const oldStarted = createDeferred();
      const sent: ACPMessageData[] = [];
      const accepted: string[] = [];
      let submissions = 0;
      let completions = 0;
      const backend = {
        ...createFakeAcpRuntimeBackend(),
        compactContext: async () => {
          oldStarted.resolve();
          await oldCallback.promise;
        },
        sendPromptWithEvidence: async (): Promise<AcpPromptSubmissionEvidence> => {
          if (++submissions === 1 && stage === 'submission') {
            oldStarted.resolve();
            return oldSubmission.promise;
          }
          return { kind: 'exact_final_response', response: { stopReason: 'end_turn' } };
        },
        waitForResponseComplete: async (): Promise<AcpTurnOutcome> => {
          if (++completions === 1 && (stage === 'completion' || stage === 'cancelled-outcome')) {
            oldStarted.resolve();
            return oldCompletion.promise;
          }
          return { kind: 'completed', stopReason: 'end_turn' };
        },
      };
      const runtime = createAcpRuntime({
        provider: 'customAcp',
        directory: '/tmp',
        session: createBasicSessionClientWithOverrides({
          sendAgentMessage: (_provider, body) => { sent.push(body); },
        }),
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        ensureBackend: async () => backend,
      });

      await runtime.startOrLoad({});
      runtime.beginTurn();
      const oldOperation = stage === 'compact'
        ? runtime.compactContext('/compact')
        : runtime.sendPromptWithMeta({
            text: 'old prompt',
            localId: 'old-local-id',
            ...(stage === 'submitted-callback'
              ? { onProviderPromptSubmitted: async () => {
                  oldStarted.resolve();
                  await oldCallback.promise;
                } }
              : { onProviderPromptAccepted: () => { accepted.push('old-local-id'); } }),
          });
      const oldResult = oldOperation.then(() => null, (error: unknown) => error);
      await oldStarted.promise;
      await runtime.cancel();

      runtime.beginTurn();
      await runtime.sendPromptWithMeta({
        text: 'replacement',
        localId: 'replacement-local-id',
        onProviderPromptAccepted: () => { accepted.push('replacement-local-id'); },
      });
      if (stage === 'submission') {
        oldSubmission.reject(new AcpPromptSubmissionPhaseError(
          'rejected_before_effect',
          markTurnFailure(new Error('late superseded prompt failure')),
        ));
      } else if (stage === 'completion') {
        oldCompletion.reject(markTurnFailure(new Error('late superseded prompt failure')));
      } else if (stage === 'cancelled-outcome') {
        oldCompletion.resolve({ kind: 'aborted', stopReason: 'cancelled' });
      } else {
        oldCallback.reject(markTurnFailure(new Error('late superseded prompt failure')));
      }
      const oldError = await oldResult;
      expect(isAbortLikeError(oldError)).toBe(true);
      expect(await runtime.failTurn(oldError)).toBe(false);
      expect(runtime.isTurnInFlight()).toBe(true);
      expect(sent.some((message) => message.type === 'turn_failed')).toBe(false);

      await runtime.flushTurn();
      expect(sent.filter((message) => message.type === 'task_complete')).toHaveLength(1);
      runtime.beginTurn();
      await runtime.sendPromptWithMeta({
        text: 'ordinary follow-up',
        localId: 'followup-local-id',
        onProviderPromptAccepted: () => { accepted.push('followup-local-id'); },
      });
      await runtime.flushTurn();
      expect(accepted).toContain('replacement-local-id');
      expect(accepted).toContain('followup-local-id');
      if (stage === 'submission') expect(accepted).not.toContain('old-local-id');
      expect(sent.filter((message) => message.type === 'task_complete')).toHaveLength(2);
      await runtime.reset();
    },
  );

  it('preserves structured prompt metadata on the first follow-up after vendor resume', async () => {
    const sendPromptPayloadWithEvidence = vi.fn(async () => ({
      kind: 'exact_final_response' as const,
      response: { stopReason: 'end_turn' } as PromptResponse,
    }));
    const backend = {
      ...createFakeAcpRuntimeBackend({ sessionId: 'vendor-resume-1' }),
      loadSession: vi.fn(async () => ({ sessionId: 'vendor-resume-1' })),
      sendPromptPayloadWithEvidence,
      waitForResponseComplete: vi.fn(async () => ({ kind: 'completed' as const, stopReason: 'end_turn' as const })),
    };
    const runtime = createAcpRuntime({
      provider: 'customAcp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: 'vendor-resume-1', importHistory: true });
    const meta = { happierStructuredInputV1: { v: 1, imageInputs: [{ path: 'image.png' }] } };
    await runtime.sendPromptWithMeta({ text: 'follow up', meta });

    expect(backend.loadSession).toHaveBeenCalledWith('vendor-resume-1', undefined);
    expect(sendPromptPayloadWithEvidence).toHaveBeenCalledWith('vendor-resume-1', {
      text: 'follow up',
      meta,
    });
  });

  it('does not report exact provider acceptance when sendPrompt returns before the final prompt response', async () => {
    type ExactFinalResponseEvidence = Readonly<{
      kind: 'exact_final_response';
      response: PromptResponse;
    }>;
    let resolveFinalResponse!: (evidence: ExactFinalResponseEvidence) => void;
    const finalResponseEvidence = new Promise<ExactFinalResponseEvidence>((resolve) => {
      resolveFinalResponse = resolve;
    });
    const sendPrompt = vi.fn(async () => undefined);
    const waitForResponseComplete = vi.fn(async () => {
      await finalResponseEvidence;
      return { kind: 'completed' as const, stopReason: 'end_turn' as const };
    });
    const onProviderPromptAccepted = vi.fn();
    const backend = {
      ...createFakeAcpRuntimeBackend({ sendPrompt, waitForResponseComplete }),
      sendPromptWithEvidence: vi.fn(async () => ({
        kind: 'effect_may_have_occurred' as const,
        finalResponseEvidence,
      })),
    };
    const runtime = createAcpRuntime({
      provider: 'customAcp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    const prompt = runtime.sendPromptWithMeta({
      text: 'hello',
      localId: 'local-1',
      onProviderPromptAccepted,
    });

    await vi.waitFor(() => {
      expect(waitForResponseComplete).toHaveBeenCalledTimes(1);
    });

    try {
      // AcpBackend.sendPrompt can return on weak or uncorrelated session/update liveness.
      // Without a handled current-turn provider effect, only the final session/prompt
      // response proves that this exact request reached the agent.
      expect(onProviderPromptAccepted).not.toHaveBeenCalled();
    } finally {
      resolveFinalResponse({
        kind: 'exact_final_response',
        response: { stopReason: 'end_turn' },
      });
      await prompt;
    }

    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it('does not report provider acceptance when completion fails and the exact response is lost after liveness', async () => {
    const finalResponseEvidence = new Promise<Readonly<{
      kind: 'exact_final_response';
      response: PromptResponse;
    }>>(() => {});
    let rejectResponseCompletion!: (error: Error) => void;
    const responseCompletion = new Promise<void>((_resolve, reject) => {
      rejectResponseCompletion = reject;
    });
    const onProviderPromptAccepted = vi.fn();
    const waitForResponseComplete = vi.fn(async () => {
      await responseCompletion;
    });
    const backend = {
      ...createFakeAcpRuntimeBackend({ waitForResponseComplete }),
      sendPromptWithEvidence: vi.fn(async () => ({
        kind: 'effect_may_have_occurred' as const,
        finalResponseEvidence,
      })),
    };
    const runtime = createAcpRuntime({
      provider: 'customAcp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    const prompt = runtime.sendPromptWithMeta({
      text: 'hello',
      localId: 'local-1',
      onProviderPromptAccepted,
    });

    await vi.waitFor(() => {
      expect(waitForResponseComplete).toHaveBeenCalledTimes(1);
    });
    const cancellationError = new Error('Cancelled before final prompt response');
    cancellationError.name = 'AbortError';
    rejectResponseCompletion(cancellationError);

    await expect(prompt).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Cancelled before final prompt response',
    });
    expect(onProviderPromptAccepted).not.toHaveBeenCalled();
  });

  it('accepts an intentionally ignored provider terminal error without requiring a fabricated final response', async () => {
    const onProviderPromptAccepted = vi.fn();
    const backend = {
      ...createFakeAcpRuntimeBackend(),
      sendPromptWithEvidence: vi.fn(async () => ({
        kind: 'accepted_without_exact_final_response' as const,
      })),
      waitForResponseComplete: vi.fn(async () => ({
        kind: 'completed' as const,
        stopReason: 'end_turn' as const,
      })),
    };
    const runtime = createAcpRuntime({
      provider: 'customAcp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.sendPromptWithMeta({
      text: 'hello',
      localId: 'local-ignored-terminal-error',
      onProviderPromptAccepted,
    });

    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.waitForResponseComplete).toHaveBeenCalledTimes(1);
  });

  it('translates an exact ACP rejection after invocation to provider_rejected_before_acceptance', async () => {
    const backend = {
      ...createFakeAcpRuntimeBackend(),
      sendPromptWithEvidence: vi.fn(async () => {
        throw new AcpPromptSubmissionPhaseError(
          'rejected_before_effect',
          new Error('ACP rejected the prompt before acceptance'),
        );
      }),
    };
    const runtime = createAcpRuntime({
      provider: 'customAcp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    await expect(runtime.sendPromptWithMeta({
      text: 'hello',
      localId: 'local-1',
    })).rejects.toBeInstanceOf(ProviderPromptSubmissionRejectedBeforeEffectError);
    await expect(runtime.sendPromptWithMeta({
      text: 'hello again',
      localId: 'local-2',
    })).rejects.toMatchObject({
      reason: 'provider_rejected_before_acceptance',
      message: 'ACP rejected the prompt before acceptance',
    });
  });

  it('keeps a missing runtime session classified as runtime_disposed_before_delivery', async () => {
    const runtime = createAcpRuntime({
      provider: 'customAcp',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => createFakeAcpRuntimeBackend(),
    });

    await expect(runtime.sendPromptWithMeta({
      text: 'hello',
      localId: 'local-missing-session',
    })).rejects.toMatchObject({
      reason: 'runtime_disposed_before_delivery',
      message: 'customAcp ACP session was not started',
    });
  });
});
