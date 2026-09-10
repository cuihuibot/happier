/**
 * Typed terminal-outcome precedence at the shared turn classifier.
 *
 * The classifier decides whether a failed turn is reported to the user as a
 * cancellation. It did so by sniffing the error MESSAGE for "abort"/"cancel",
 * so a genuine failure whose text merely mentions a failed abort was silently
 * reclassified as a cancellation, which suppresses `failTurn` while the prompt
 * loop still flushes -- publishing `task_complete` for a failed turn.
 *
 * The fix is a typed marker consulted BEFORE the heuristic. Unmarked errors
 * must keep the exact previous behavior: every existing producer relies on it.
 */
import { describe, expect, it } from 'vitest';

import {
  isAbortLikeError,
  markTurnCancellation,
  markTurnFailure,
} from './turnDelivery';

describe('turnDelivery typed termination marker', () => {
  it('classifies an explicitly marked failure as a failure despite abort wording', () => {
    // This is the exact shape the SDK backend produces on timeout: the turn
    // failed, and the aggregated detail mentions that the abort also failed.
    const error = markTurnFailure(
      new Error('native turn timed out after 60000ms; native abort also failed'),
    );
    expect(isAbortLikeError(error)).toBe(false);
  });

  it('classifies an explicitly marked cancellation as a cancellation despite neutral wording', () => {
    const error = markTurnCancellation(new Error('stopped'));
    expect(isAbortLikeError(error)).toBe(true);
  });

  it('honors a marked failure carried as a nested cause', () => {
    const inner = markTurnFailure(new Error('usage threshold reached'));
    const outer = new Error('turn cancelled while stopping', { cause: inner });
    expect(isAbortLikeError(outer)).toBe(false);
  });

  it('honors a marked failure inside an AggregateError', () => {
    const aggregate = new AggregateError(
      [new Error('abort acknowledgement failed'), markTurnFailure(new Error('turn failed'))],
      'cancelled during shutdown',
    );
    expect(isAbortLikeError(aggregate)).toBe(false);
  });

  it('lets an explicit cancellation marker win over a nested failure-shaped message', () => {
    const cancellation = markTurnCancellation(
      new Error('user stop', { cause: new Error('boom') }),
    );
    expect(isAbortLikeError(cancellation)).toBe(true);
  });

  it('leaves unmarked error classification exactly unchanged', () => {
    // Control: the existing heuristic is the contract for every other producer.
    expect(isAbortLikeError(new Error('aborted'))).toBe(true);
    expect(isAbortLikeError(new Error('Cancelled by user'))).toBe(true);
    expect(isAbortLikeError(new Error('boom'))).toBe(false);
    expect(isAbortLikeError(Object.assign(new Error('anything'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError('cancel')).toBe(true);
    expect(isAbortLikeError({})).toBe(false);
  });

  it('does not treat an unmarked nested cause as a marker', () => {
    const outer = new Error('cancelled', { cause: new Error('unrelated failure') });
    expect(isAbortLikeError(outer)).toBe(true);
  });

  it('preserves the original error identity when marking', () => {
    const original = new Error('native turn failed');
    const marked = markTurnFailure(original);
    expect(marked).toBe(original);
    expect(marked.message).toBe('native turn failed');
  });
});
