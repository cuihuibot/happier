import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { SESSION_ABORT_FLUSH_BUDGET_MS } from '@/session/transport/shared/sessionTimeouts';

import { flushSessionWithinAbortBudget } from './sessionAbortFlush';

describe('flushSessionWithinAbortBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports settled when the session flush completes inside the budget', async () => {
    const result = await flushSessionWithinAbortBudget({
      flush: async () => undefined,
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    });

    expect(result).toEqual({ settled: true });
  });

  it('reports settled when the session exposes no flush', async () => {
    const result = await flushSessionWithinAbortBudget({
      flush: undefined,
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    });

    expect(result).toEqual({ settled: true });
  });

  it('stops waiting at the production budget and reports the unsettled drain', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
    const pending = flushSessionWithinAbortBudget({
      flush: () => new Promise<void>(() => undefined),
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    });

    await vi.advanceTimersByTimeAsync(SESSION_ABORT_FLUSH_BUDGET_MS - 1);
    let settledEarly = false;
    void pending.then(() => {
      settledEarly = true;
    });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ settled: false, budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS });
    expect(infoFile).toHaveBeenCalledWith(
      expect.stringContaining('did not settle within the abort flush budget'),
      expect.objectContaining({ budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS, reason: 'Aborted by user' }),
    );
  });

  it('propagates a flush failure inside the budget instead of reporting a silent success', async () => {
    await expect(flushSessionWithinAbortBudget({
      flush: async () => {
        throw new Error('flush failed');
      },
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    })).rejects.toThrow('flush failed');
  });

  /**
   * `ApiSessionClient.flush()` resolves after the budget owner has already reported the unsettled
   * drain, so a failure that arrives late can no longer reach the awaiting caller. It must still be
   * observable on a default-on signal — as a closed classification, never as free-form error text,
   * because `logger.infoFile` applies no redaction to what it writes.
   */
  it('reports a late flush failure as a closed classification without its error payload', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    // Synthetic sentinels only: no real secret material is used anywhere in this test.
    const secretMessage = 'sentinel-private-payload-2f8a1c';
    const secretName = 'SentinelNamed-9d31b7';

    try {
      const lateFailure = new Error(secretMessage);
      lateFailure.name = secretName;
      const pending = flushSessionWithinAbortBudget({
        flush: () => new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(lateFailure), SESSION_ABORT_FLUSH_BUDGET_MS + 20);
        }),
        logPrefix: '[Test]',
        reason: 'Aborted by user',
      });

      await vi.advanceTimersByTimeAsync(SESSION_ABORT_FLUSH_BUDGET_MS);
      expect(await pending).toEqual({ settled: false, budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS });

      await vi.advanceTimersByTimeAsync(20);

      // `JSON.stringify` renders an Error as `{}`, which would hide a leak, so the recorded
      // arguments are inspected the way a file sink would render them. This runs before the
      // shape assertion so a leaked payload fails here.
      const written = inspect(infoFile.mock.calls, { depth: 8 });
      expect(written).not.toContain(secretMessage);
      expect(written).not.toContain(secretName);
      expect(infoFile).toHaveBeenCalledWith(
        expect.stringContaining('failed after the abort flush budget expired'),
        { budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS, reason: 'Aborted by user', failure: 'unclassified-error' },
      );
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('classifies a known transport failure code without free-form text', async () => {
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
    const lateFailure = Object.assign(new Error('sentinel-private-payload-e11c'), { code: 'ETIMEDOUT' });

    const pending = flushSessionWithinAbortBudget({
      flush: () => new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(lateFailure), SESSION_ABORT_FLUSH_BUDGET_MS + 5);
      }),
      logPrefix: '[Test]',
      reason: 'Session ended',
    });

    await vi.advanceTimersByTimeAsync(SESSION_ABORT_FLUSH_BUDGET_MS);
    expect(await pending).toEqual({ settled: false, budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS });
    await vi.advanceTimersByTimeAsync(5);

    expect(inspect(infoFile.mock.calls, { depth: 8 })).not.toContain('sentinel-private-payload-e11c');
    expect(infoFile).toHaveBeenCalledWith(
      expect.stringContaining('failed after the abort flush budget expired'),
      { budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS, reason: 'Session ended', failure: 'ETIMEDOUT' },
    );
  });
  it('spends at most one budget per owner while the same drain is still unsettled', async () => {
    vi.spyOn(logger, 'infoFile').mockImplementation(() => undefined);
    const owner = {};

    const first = flushSessionWithinAbortBudget({
      owner,
      flush: () => new Promise<void>(() => undefined),
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    });
    await vi.advanceTimersByTimeAsync(SESSION_ABORT_FLUSH_BUDGET_MS);
    expect(await first).toEqual({ settled: false, budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS });

    // The corridor calls the owner again (handleAbort, then runtime.cancel). The
    // writes it would wait for are the same ones the first call already spent the
    // whole budget on, so a second full budget would double the corridor's wait
    // and break the documented ack-contract headroom.
    const startedAt = Date.now();
    const second = await flushSessionWithinAbortBudget({
      owner,
      flush: () => new Promise<void>(() => undefined),
      logPrefix: '[Test]',
      reason: 'ACP runtime cancelled',
    });

    expect(second).toEqual({ settled: false, budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS });
    expect(Date.now() - startedAt).toBe(0);
  });

  it('restores a full budget for an owner once its drain settles', async () => {
    const owner = {};

    expect(await flushSessionWithinAbortBudget({
      owner,
      flush: async () => undefined,
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    })).toEqual({ settled: true });

    const pending = flushSessionWithinAbortBudget({
      owner,
      flush: () => new Promise<void>(() => undefined),
      logPrefix: '[Test]',
      reason: 'Aborted by user',
    });
    await vi.advanceTimersByTimeAsync(SESSION_ABORT_FLUSH_BUDGET_MS - 1);
    let settledEarly = false;
    void pending.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ settled: false, budgetMs: SESSION_ABORT_FLUSH_BUDGET_MS });
  });
});
