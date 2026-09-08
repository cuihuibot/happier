import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '@/agent/core/AgentMessage';

/**
 * Regression coverage for the reproduced GitHub Copilot "autopilot" reply loss.
 *
 * Observed on 2026-09-08 (Happier session cmtsjo5zh0a29npp8z7s9a7o3, native Copilot
 * session 92a8f6f0-4589-4d3a-8d76-74443e4c7763):
 *
 *   10:47:57.674Z  session/prompt (RPC 6) resolves stopReason=end_turn
 *   10:47:57.708Z  usage_update
 *   10:47:59.193Z  tool_call        task_complete(summary=QRP_366AC45A_STAGE_TWO)
 *   10:47:59.195Z  tool_call_update completed
 *
 * The provider kept working after resolving the prompt turn, so Happier dropped both
 * continuation notifications with "Dropping prompt-turn session/update outside an
 * active dispatched generation" and the summary never reached the transcript.
 */

const SESSION_ID = 'sess_autopilot';

function createBackend(options?: Record<string, unknown>) {
  const backend = new AcpBackend({
    agentName: 'copilot',
    cwd: process.cwd(),
    command: 'noop',
    providerAutonomousContinuation: { stallMs: 50 },
    ...options,
  } as never);
  const emitted: AgentMessage[] = [];
  backend.onMessage((msg) => emitted.push(msg));
  (backend as any).acpSessionId = SESSION_ID;
  return { backend, emitted };
}

/** Drive the backend into the exact post-`end_turn` state observed in the capture. */
function completePromptTurn(backend: AcpBackend, stopReason: 'end_turn' = 'end_turn') {
  (backend as any).turnGeneration = 1;
  (backend as any).dispatchedPromptTurnGeneration = 1;
  (backend as any).waitingForResponse = true;
  (backend as any).finalizeTurnOutcome({ kind: 'completed', stopReason });
}

const taskCompleteToolCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_ZXnnWnmnPCRqkxxnL6JI9Nqk',
  title: 'task_complete',
  kind: 'other',
  status: 'pending',
  rawInput: { summary: 'QRP_366AC45A_STAGE_TWO' },
};

const continuationText = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'PLAIN_CONTINUATION_PROSE' },
  messageChunk: { textDelta: 'PLAIN_CONTINUATION_PROSE' },
};

function continuationEvents(emitted: AgentMessage[]) {
  return emitted.filter(
    (msg): msg is Extract<AgentMessage, { type: 'event' }> =>
      msg.type === 'event' && msg.name === 'autonomous_continuation',
  );
}

describe('AcpBackend provider-autonomous continuation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts the captured task_complete continuation emitted after stopReason=end_turn', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({
      sessionId: SESSION_ID,
      update: taskCompleteToolCall,
    });

    const started = continuationEvents(emitted).filter((e) => (e.payload as any)?.phase === 'started');
    expect(started).toHaveLength(1);

    const toolCall = emitted.find((msg) => msg.type === 'tool-call');
    expect(toolCall).toBeTruthy();
    expect(JSON.stringify((toolCall as any).args)).toContain('QRP_366AC45A_STAGE_TWO');
  });

  it('closes the continuation immediately on a status-only task_complete tool_call_update', async () => {
    // Copilot sends `tool_call` with the title and `tool_call_update` with status only, so the
    // terminal detector must correlate the completion by toolCallId rather than by title.
    const { backend, emitted } = createBackend({ providerAutonomousContinuation: { stallMs: 600_000 } });
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });
    await (backend as any).handleSessionUpdate({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: taskCompleteToolCall.toolCallId,
        status: 'completed',
      },
    });

    const ended = continuationEvents(emitted).filter((e) => (e.payload as any)?.phase === 'ended');
    expect(ended).toHaveLength(1);
    expect((backend as any).isAutonomousContinuationActive()).toBe(false);
  });

  it('keeps the continuation open across an ordinary provider pause between thought and prose', async () => {
    // The provider stays silent while it reasons. With the shipped Copilot opt-in defaults the
    // stall budget must not end the run before a deterministic terminal signal, otherwise the
    // following prose crosses a segment boundary and can be lost.
    const { backend, emitted } = createBackend({ providerAutonomousContinuation: {} });
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({
      sessionId: SESSION_ID,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: continuationText });

    const started = continuationEvents(emitted).filter((e) => (e.payload as any)?.phase === 'started');
    expect(started).toHaveLength(1);
    expect(
      emitted.some(
        (msg) => msg.type === 'model-output'
          && `${(msg as any).textDelta ?? ''}${(msg as any).fullText ?? ''}`.includes('PLAIN_CONTINUATION_PROSE'),
      ),
    ).toBe(true);
  });

  it('accepts a plain assistant-prose autonomous continuation', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({
      sessionId: SESSION_ID,
      update: continuationText,
    });

    expect(
      emitted.some(
        (msg) => msg.type === 'model-output'
          && `${(msg as any).textDelta ?? ''}${(msg as any).fullText ?? ''}`.includes('PLAIN_CONTINUATION_PROSE'),
      ),
    ).toBe(true);
  });

  it('re-asserts a running status for the continuation and only reports idle when it ends', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);
    const statusesAfterCompletion = () => emitted
      .filter((msg): msg is Extract<AgentMessage, { type: 'status' }> => msg.type === 'status')
      .map((msg) => msg.status);

    expect(statusesAfterCompletion()).toContain('idle');
    const idleCountBefore = statusesAfterCompletion().filter((s) => s === 'idle').length;

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });
    expect(statusesAfterCompletion().at(-1)).toBe('running');
    expect(statusesAfterCompletion().filter((s) => s === 'idle')).toHaveLength(idleCountBefore);

    // The announced `task_complete` tool call is still unresolved, so the stall budget is
    // extended a bounded number of times before the safety stop fires.
    await vi.advanceTimersByTimeAsync(50 * 25);

    const ended = continuationEvents(emitted).filter((e) => (e.payload as any)?.phase === 'ended');
    expect(ended).toHaveLength(1);
    expect(statusesAfterCompletion().filter((s) => s === 'idle')).toHaveLength(idleCountBefore + 1);
  });

  it('never reopens a completed turn on a usage_update alone', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({
      sessionId: SESSION_ID,
      update: { sessionUpdate: 'usage_update', used: 10, size: 100 },
    });

    expect(continuationEvents(emitted)).toHaveLength(0);
    expect((backend as any).dispatchedPromptTurnGeneration).toBeNull();
  });

  it('never reopens after a cancelled turn', async () => {
    const { backend, emitted } = createBackend();
    (backend as any).turnGeneration = 1;
    (backend as any).dispatchedPromptTurnGeneration = 1;
    (backend as any).waitingForResponse = true;
    (backend as any).finalizeTurnOutcome({ kind: 'aborted', stopReason: 'cancelled' });

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });

    expect(continuationEvents(emitted)).toHaveLength(0);
    expect(emitted.some((msg) => msg.type === 'tool-call')).toBe(false);
  });

  it('never reopens for a mismatched session id', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({
      sessionId: 'sess_someone_else',
      update: taskCompleteToolCall,
    });

    expect(continuationEvents(emitted)).toHaveLength(0);
    expect(emitted.some((msg) => msg.type === 'tool-call')).toBe(false);
  });

  it('never reopens after disposal', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);
    (backend as any).disposed = true;

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });

    expect(continuationEvents(emitted)).toHaveLength(0);
  });

  it('never reopens while a loadSession replay is capturing', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);
    (backend as any).replayCapture = { handleUpdate: () => {} };

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });

    expect(continuationEvents(emitted)).toHaveLength(0);
  });

  it('stays disabled for providers that do not opt in', async () => {
    const backend = new AcpBackend({
      agentName: 'claude',
      cwd: process.cwd(),
      command: 'noop',
    });
    const emitted: AgentMessage[] = [];
    backend.onMessage((msg) => emitted.push(msg));
    (backend as any).acpSessionId = SESSION_ID;
    completePromptTurn(backend);

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });

    expect(continuationEvents(emitted)).toHaveLength(0);
    expect(emitted.some((msg) => msg.type === 'tool-call')).toBe(false);
  });

  it('bounds the number of autonomous continuations per completed prompt turn', async () => {
    const { backend, emitted } = createBackend({
      providerAutonomousContinuation: { maxPerTurn: 2, stallMs: 50 },
    });
    completePromptTurn(backend);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await (backend as any).handleSessionUpdate({
        sessionId: SESSION_ID,
        update: { ...taskCompleteToolCall, toolCallId: `call_${attempt}` },
      });
      await vi.advanceTimersByTimeAsync(50 * 25);
    }

    const started = continuationEvents(emitted).filter((e) => (e.payload as any)?.phase === 'started');
    expect(started).toHaveLength(2);
  });

  it('drops a late continuation once the next client prompt owns the session', async () => {
    const { backend, emitted } = createBackend();
    completePromptTurn(backend);

    // The next client prompt takes ownership; the stale continuation must not reopen.
    (backend as any).turnGeneration = 2;
    (backend as any).closedTurnGeneration = null;
    (backend as any).dispatchedPromptTurnGeneration = null;
    (backend as any).waitingForResponse = true;
    (backend as any).disarmAutonomousContinuation('next prompt');

    await (backend as any).handleSessionUpdate({ sessionId: SESSION_ID, update: taskCompleteToolCall });

    expect(continuationEvents(emitted)).toHaveLength(0);
  });
});
