import { logger } from '@/ui/logger';
import { SESSION_ABORT_FLUSH_BUDGET_MS } from '@/session/transport/shared/sessionTimeouts';

export type SessionAbortFlushResult =
  | Readonly<{ settled: true }>
  | Readonly<{ settled: false; budgetMs: number }>;

/**
 * Closed classification for a best-effort flush failure.
 *
 * `logger.infoFile` writes verbatim: it applies none of the redaction the fatal-error path uses. A
 * flush rejection can carry request payloads, tokens, or environment values in its message, so the
 * corridor reports only these fixed values plus its own numeric budget and internal abort reason —
 * never `Error.message`, `Error.name`, or any other caller-supplied text.
 */
const CLASSIFIED_FLUSH_FAILURE_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE',
  'ABORT_ERR',
] as const;

export type SessionAbortFlushFailure =
  | (typeof CLASSIFIED_FLUSH_FAILURE_CODES)[number]
  | 'aborted'
  | 'non-error-value'
  | 'unclassified-error';

/**
 * Open abort-flush deadline for each session whose best-effort drain is still unsettled.
 *
 * Keyed weakly by the session so a finished session cannot retain it.
 */
const openAbortFlushDeadlineByOwner = new WeakMap<object, number>();

function classifyFlushFailure(error: unknown): SessionAbortFlushFailure {  if (typeof error !== 'object' || error === null) return 'non-error-value';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    const known = CLASSIFIED_FLUSH_FAILURE_CODES.find((candidate) => candidate === code);
    if (known) return known;
  }
  if ((error as { name?: unknown }).name === 'AbortError') return 'aborted';
  return 'unclassified-error';
}

/**
 * Canonical bounded session flush for the cancellation corridor.
 *
 * `ApiSessionClient.flush()` first drains every best-effort session write it still owns — the
 * transcript commit queue, the durable mutation outbox, and pending session turn writes — and only
 * then waits on its separately bounded socket ping. Each individual write is bounded, but their
 * number is not, so an abort that awaits the whole flush before emitting its terminal outcome,
 * cancelling the runtime, and acknowledging the client can outlive the client abort contract.
 *
 * Cancellation is the priority here and persistence of the cancellation is best effort, so the
 * corridor waits at most `SESSION_ABORT_FLUSH_BUDGET_MS`. Unsettled writes keep draining in the
 * background: expiry is reported rather than treated as success, a failure inside the budget still
 * reaches the caller, and a failure that arrives after expiry is reported here because the caller
 * has already moved on and can no longer observe it.
 *
 * The budget is owned per drain, not per call. One cancellation reaches this helper more than once
 * — `runStandardAcpProvider.handleAbort` flushes, then `runtime.cancel()` flushes again through
 * `abortPendingAcpPermissionRequests` — and every caller drains the same session writes. Charging
 * each call a fresh budget makes the corridor's total wait a multiple of the budget, which breaks
 * the ack-contract headroom this constant is derived from. While a drain started for `owner` is
 * still unsettled, later calls therefore spend only what remains of that first budget; once it
 * settles, the next call starts a fresh one.
 *
 * `backends/opencode/server/raceWithTimeout` expresses the same race and could carry this contract,
 * but it is a provider-server-local helper: consuming it from the shared permissions corridor would
 * mean either a cross-layer import from a backend or relocating it, which is a wider refactor than
 * this fault corridor. The corridor-specific reporting contract lives here instead.
 */
export async function flushSessionWithinAbortBudget(params: Readonly<{
  flush: (() => Promise<void>) | undefined;
  logPrefix: string;
  reason: string;
  /**
   * The session whose best-effort writes are drained. Callers that share one drain pass the same
   * object so a single cancellation cannot spend the budget more than once.
   */
  owner?: object;
}>): Promise<SessionAbortFlushResult> {
  if (!params.flush) return { settled: true };

  const budgetMs = SESSION_ABORT_FLUSH_BUDGET_MS;
  const owner = params.owner;
  const startedAt = Date.now();
  const openDeadlineAt = owner ? openAbortFlushDeadlineByOwner.get(owner) : undefined;
  const deadlineAt = openDeadlineAt ?? startedAt + budgetMs;
  const remainingMs = Math.max(0, deadlineAt - startedAt);

  const flushed = params.flush();
  let expired = remainingMs === 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const observed = flushed.then(
    (): SessionAbortFlushResult => ({ settled: true }),
    (error: unknown): SessionAbortFlushResult => {
      if (!expired) throw error;
      logger.infoFile(
        `${params.logPrefix} Best-effort session writes failed after the abort flush budget expired`,
        { budgetMs, reason: params.reason, failure: classifyFlushFailure(error) },
      );
      return { settled: false, budgetMs };
    },
  );

  if (owner) {
    openAbortFlushDeadlineByOwner.set(owner, deadlineAt);
    const releaseOwnerBudget = () => {
      if (openAbortFlushDeadlineByOwner.get(owner) === deadlineAt) {
        openAbortFlushDeadlineByOwner.delete(owner);
      }
    };
    void observed.then(releaseOwnerBudget, releaseOwnerBudget);
  }

  if (remainingMs === 0) {
    // The corridor already spent this drain's whole budget. Waiting again cannot bound it, so
    // report the same unsettled result instead of charging the client contract a second budget.
    logger.infoFile(
      `${params.logPrefix} Abort flush budget for these session writes was already spent; cancellation continued without waiting again`,
      { budgetMs, reason: params.reason },
    );
    void observed.catch(() => undefined);
    return { settled: false, budgetMs };
  }

  try {
    return await Promise.race<SessionAbortFlushResult>([
      observed,
      new Promise<SessionAbortFlushResult>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          logger.infoFile(
            `${params.logPrefix} Best-effort session writes did not settle within the abort flush budget; cancellation continued with writes still draining`,
            { budgetMs, reason: params.reason },
          );
          resolve({ settled: false, budgetMs });
        }, remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // After expiry the losing branch keeps draining and already reports its own failure above; this
    // only keeps the abandoned result from surfacing as an unhandled rejection.
    void observed.catch(() => undefined);
  }
}
