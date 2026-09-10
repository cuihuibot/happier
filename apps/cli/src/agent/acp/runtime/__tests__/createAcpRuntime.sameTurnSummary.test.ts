import { describe, expect, it } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Repair coverage for PA-AC-003.
 *
 * Observed live on the v3 native candidate (Happier session cmtspnf8l0f7xnpp84ylz6c51):
 * the provider produced commentary `R2LIVE_STAGE1_7F31`, ran a tool, and finished the *same*
 * client turn with a canonical `task_complete` whose summary carried `R2LIVE_STAGE2_7F31`.
 * The completion lifecycle was published, but zero assistant rows contained the summary.
 *
 * The existing summary fallback only ran when the accumulated response was empty, so a turn
 * that narrated first lost its final answer. The summary is now published as its own durable
 * segment with a stable identity, exactly once, without touching the commentary segment.
 */

const SESSION_ID = 'sess_same_turn_summary';

type Harness = {
  backend: ReturnType<typeof createFakeAcpRuntimeBackend>;
  runtime: ReturnType<typeof createAcpRuntime>;
  durableCalls: Array<{ localId: string; body: ACPMessageData }>;
  plainCalls: ACPMessageData[];
};

async function createHarness(): Promise<Harness> {
  const backend = createFakeAcpRuntimeBackend({ sessionId: SESSION_ID });
  const durableCalls: Array<{ localId: string; body: ACPMessageData }> = [];
  const plainCalls: ACPMessageData[] = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessageCommitted: async (_provider, body, options) => {
      durableCalls.push({ localId: options.localId, body });
    },
    sendAgentMessage: (_provider, body) => {
      plainCalls.push(body);
    },
  });
  const runtime = createAcpRuntime({
    provider: 'copilot',
    directory: '/tmp',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => backend,
  });
  await runtime.startOrLoad({});
  return { backend, runtime, durableCalls, plainCalls };
}

function taskCompleteCall(callId: string, summary: string): AgentMessage {
  return {
    type: 'tool-call',
    callId,
    toolName: 'task_complete',
    args: { summary, _acp: { title: 'task_complete' } },
  } as AgentMessage;
}

function toolResult(callId: string, result: unknown): AgentMessage {
  return { type: 'tool-result', callId, toolName: 'task_complete', result } as AgentMessage;
}

/**
 * Drive the genuine commentary -> tool -> result -> flush sequence of one client turn.
 */
async function runCommentaryThenSummary(
  h: Harness,
  opts: { commentary: string; callId: string; summary: string; result?: unknown },
): Promise<void> {
  h.runtime.beginTurn();
  h.backend.emit({ type: 'model-output', textDelta: opts.commentary } satisfies AgentMessage);
  h.backend.emit({
    type: 'tool-call',
    callId: 'shell_1',
    toolName: 'bash',
    args: { command: 'echo hello' },
  } as AgentMessage);
  h.backend.emit(toolResult('shell_1', 'hello'));
  h.backend.emit(taskCompleteCall(opts.callId, opts.summary));
  h.backend.emit(toolResult(opts.callId, opts.result ?? { ok: true }));
  await h.runtime.flushTurn();
}

/**
 * The streamed transcript writer commits an assistant row twice (streaming checkpoint and final
 * commit) under one `localId`, so transcript rows are counted by distinct identity.
 */
function summaryRows(h: Harness, marker: string): Array<{ localId: string }> {
  const seen = new Map<string, { localId: string }>();
  for (const { localId, body } of h.durableCalls) {
    if (body.type === 'message' && body.message.includes(marker) && !seen.has(localId)) {
      seen.set(localId, { localId });
    }
  }
  return [...seen.values()];
}

describe('same-turn task_complete summary projection', () => {
  it('persists the final summary once when commentary was already displayed', async () => {
    const h = await createHarness();
    await runCommentaryThenSummary(h, {
      commentary: 'R2LIVE_STAGE1_7F31',
      callId: 'call_vQeoMuLF984l9DbGTgKgnUgr',
      summary: 'Created qa-marker.txt with the exact verified content. R2LIVE_STAGE2_7F31',
    });

    expect(
      summaryRows(h, 'R2LIVE_STAGE2_7F31'),
      'a final task_complete summary must persist even when commentary came first',
    ).toHaveLength(1);
    expect(
      h.durableCalls.some(
        ({ body }) => body.type === 'message' && body.message.includes('R2LIVE_STAGE1_7F31'),
      ),
      'the commentary segment must be preserved, not overwritten',
    ).toBe(true);
    expect(h.plainCalls.filter((body) => body.type === 'task_complete')).toHaveLength(1);
  });

  it('uses a stable row identity so a direct retry does not duplicate the summary', async () => {
    const h = await createHarness();
    const call = {
      commentary: 'RETRY_COMMENTARY',
      callId: 'call_stable_identity',
      summary: 'RETRY_SUMMARY_MARKER',
    };
    await runCommentaryThenSummary(h, call);
    const firstLocalId = summaryRows(h, 'RETRY_SUMMARY_MARKER')[0]?.localId;
    expect(firstLocalId).toBeTruthy();

    await runCommentaryThenSummary(h, call);

    const rows = summaryRows(h, 'RETRY_SUMMARY_MARKER');
    expect(rows, 'a retry of the same provider turn must reuse one row identity').toHaveLength(1);
    expect(rows[0]?.localId).toBe(firstLocalId);
  });

  it('does not duplicate a summary the provider already said in visible prose', async () => {
    const h = await createHarness();
    await runCommentaryThenSummary(h, {
      commentary: 'ALREADY_VISIBLE_ANSWER',
      callId: 'call_dup',
      summary: 'ALREADY_VISIBLE_ANSWER',
    });

    expect(
      summaryRows(h, 'ALREADY_VISIBLE_ANSWER').length,
      'identical final prose must not be published twice',
    ).toBeLessThanOrEqual(1);
  });

  it('does not turn a failed task_complete into a successful answer', async () => {
    const h = await createHarness();
    await runCommentaryThenSummary(h, {
      commentary: 'FAILED_RUN_COMMENTARY',
      callId: 'call_failed',
      summary: 'FAILED_SUMMARY_MUST_NOT_APPEAR',
      result: { is_error: true, error: 'task_complete rejected' },
    });

    expect(summaryRows(h, 'FAILED_SUMMARY_MUST_NOT_APPEAR')).toHaveLength(0);
  });

  it('does not publish a summary for a cancelled turn', async () => {
    const h = await createHarness();
    h.runtime.beginTurn();
    h.backend.emit({ type: 'model-output', textDelta: 'CANCELLED_COMMENTARY' } satisfies AgentMessage);
    h.backend.emit(taskCompleteCall('call_cancelled', 'CANCELLED_SUMMARY_MUST_NOT_APPEAR'));
    h.backend.emit({
      type: 'event',
      name: 'autonomous_continuation',
      payload: { phase: 'started', continuationId: 'ignored' },
    } satisfies AgentMessage);
    await h.runtime.settleAutonomousContinuation();

    expect(summaryRows(h, 'CANCELLED_SUMMARY_MUST_NOT_APPEAR')).toHaveLength(0);
  });

  it('keeps a separate continuation summary projected exactly once', async () => {
    const h = await createHarness();
    h.runtime.beginTurn();
    h.backend.emit({ type: 'model-output', textDelta: 'CONT_STAGE_ONE' } satisfies AgentMessage);
    await h.runtime.flushTurn();

    h.backend.emit({
      type: 'event',
      name: 'autonomous_continuation',
      payload: { phase: 'started', continuationId: 'cont-summary' },
    } satisfies AgentMessage);
    h.backend.emit(taskCompleteCall('call_cont', 'CONT_STAGE_TWO'));
    h.backend.emit(toolResult('call_cont', { ok: true }));
    h.backend.emit({
      type: 'event',
      name: 'autonomous_continuation',
      payload: {
        phase: 'ended',
        continuationId: 'cont-summary',
        reason: 'task_complete',
        outcome: 'completed',
        stallMs: 30_000,
      },
    } satisfies AgentMessage);
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(summaryRows(h, 'CONT_STAGE_TWO')).toHaveLength(1);
    expect(
      h.durableCalls.some(
        ({ body }) => body.type === 'message' && body.message.includes('CONT_STAGE_ONE'),
      ),
    ).toBe(true);
  });

  it('does not restate the dispatch answer when a continuation summary repeats it', async () => {
    const h = await createHarness();
    h.runtime.beginTurn();
    h.backend.emit({
      type: 'model-output',
      textDelta: 'AUTO_R2_IDLE_RECOVER_080625Z',
    } satisfies AgentMessage);
    await h.runtime.flushTurn();

    h.backend.emit({
      type: 'event',
      name: 'autonomous_continuation',
      payload: { phase: 'started', continuationId: 'cont-restate' },
    } satisfies AgentMessage);
    h.backend.emit(taskCompleteCall('call_restate', 'AUTO_R2_IDLE_RECOVER_080625Z'));
    h.backend.emit(toolResult('call_restate', { ok: true }));
    h.backend.emit({
      type: 'event',
      name: 'autonomous_continuation',
      payload: {
        phase: 'ended',
        continuationId: 'cont-restate',
        reason: 'task_complete',
        outcome: 'completed',
        stallMs: 30_000,
      },
    } satisfies AgentMessage);
    await h.runtime.waitForAutonomousContinuationIdle();

    expect(
      summaryRows(h, 'AUTO_R2_IDLE_RECOVER_080625Z'),
      'a continuation that only restates the answer already delivered for this prompt must not add a second row',
    ).toHaveLength(1);
  });

  it('projects an independent summary for a following user prompt', async () => {
    const h = await createHarness();
    await runCommentaryThenSummary(h, {
      commentary: 'TURN_ONE_COMMENTARY',
      callId: 'call_turn_one',
      summary: 'TURN_ONE_SUMMARY',
    });
    await runCommentaryThenSummary(h, {
      commentary: 'TURN_TWO_COMMENTARY',
      callId: 'call_turn_two',
      summary: 'TURN_TWO_SUMMARY',
    });

    expect(summaryRows(h, 'TURN_ONE_SUMMARY')).toHaveLength(1);
    expect(summaryRows(h, 'TURN_TWO_SUMMARY')).toHaveLength(1);
    expect(summaryRows(h, 'TURN_ONE_SUMMARY')[0]?.localId)
      .not.toBe(summaryRows(h, 'TURN_TWO_SUMMARY')[0]?.localId);
  });

  it('keeps identical answers to two consecutive user prompts as separate rows', async () => {
    const h = await createHarness();
    for (const callId of ['call_prompt_one', 'call_prompt_two']) {
      h.runtime.beginTurn();
      h.backend.emit(taskCompleteCall(callId, 'SAME_ANSWER_BOTH_PROMPTS'));
      h.backend.emit(toolResult(callId, { ok: true }));
      await h.runtime.flushTurn();
    }

    expect(
      summaryRows(h, 'SAME_ANSWER_BOTH_PROMPTS'),
      'each independent user prompt owns its own answer row even when the text repeats',
    ).toHaveLength(2);
  });

  it('still uses the empty-response fallback when there was no commentary', async () => {
    const h = await createHarness();
    h.runtime.beginTurn();
    h.backend.emit(taskCompleteCall('call_only', 'ONLY_SUMMARY_MARKER'));
    h.backend.emit(toolResult('call_only', { ok: true }));
    await h.runtime.flushTurn();

    expect(summaryRows(h, 'ONLY_SUMMARY_MARKER')).toHaveLength(1);
  });
});
