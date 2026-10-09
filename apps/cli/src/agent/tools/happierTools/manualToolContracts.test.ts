import { describe, expect, it } from 'vitest';

import { normalizeExecutionRunStartToolInput } from './manualToolContracts';

describe('normalizeExecutionRunStartToolInput completion notifications', () => {
  it.each([false, true, undefined])('preserves the per-run override or omission %s on the legacy path', (notifyParentOnCompletion) => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'parent',
      args: { intent: 'review', backendId: 'codex',
        ...(notifyParentOnCompletion !== undefined ? { notifyParentOnCompletion } : {}) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.request.notifyParentOnCompletion).toBe(notifyParentOnCompletion);
    expect(Object.hasOwn(result.request, 'notifyParentOnCompletion')).toBe(notifyParentOnCompletion !== undefined);
  });

  it('rejects a nonboolean override rather than silently using the account default', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'parent',
      args: { intent: 'review', backendId: 'codex', notifyParentOnCompletion: 'false' },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
  });
});

describe('normalizeExecutionRunStartToolInput connected-services error contract (R4-3)', () => {
  it('rejects a malformed connected-services selection with invalid_parameters (canonical actionspec contract)', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess-1',
      args: {
        intent: 'review',
        backendId: 'codex',
        connectedServices: 123,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    // The canonical action path (actionExecutor) returns `invalid_parameters` for a malformed
    // connected-services selection; the legacy manual tool must not drift to `invalid_action_input`.
    expect(result.errorCode).toBe('invalid_parameters');
  });

  it('still rejects an unparseable run payload with invalid_action_input (unrelated codes unchanged)', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess-1',
      args: { intent: 'not-a-real-intent' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.errorCode).toBe('invalid_action_input');
  });
});
