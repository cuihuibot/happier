import type { ExecutionRunSendDelivery } from '@/agent/executionRuns/controllers/types';

export function normalizeExecutionRunSendDelivery(input: unknown): ExecutionRunSendDelivery {
  if (input === 'prompt' || input === 'steer_if_supported' || input === 'interrupt') return input;
  return 'prompt';
}

export type InFlightDeliveryAction = 'busy' | 'steer' | 'cancel_and_send';

export function resolveInFlightDeliveryAction(args: Readonly<{
  delivery: ExecutionRunSendDelivery;
  hasSteer: boolean;
}>): InFlightDeliveryAction {
  if (args.delivery === 'prompt') return 'busy';
  if (args.delivery === 'steer_if_supported') return args.hasSteer ? 'steer' : 'cancel_and_send';
  return 'cancel_and_send';
}

/**
 * Explicit terminal-outcome marker for a turn error.
 *
 * The heuristic below classifies by error MESSAGE, which cannot distinguish a
 * genuine failure that merely mentions a failed abort from a real cancellation.
 * Producers that know the outcome mark it here, and the marker is authoritative.
 * Unmarked errors keep the previous behavior exactly.
 */
const TURN_TERMINATION_OUTCOME = Symbol.for('happier.turnTerminationOutcome');

type TurnTerminationOutcome = 'failure' | 'cancellation';

function readTurnTerminationOutcome(error: unknown): TurnTerminationOutcome | null {
  if (!error || typeof error !== 'object') return null;
  const marked = (error as Record<symbol, unknown>)[TURN_TERMINATION_OUTCOME];
  return marked === 'failure' || marked === 'cancellation' ? marked : null;
}

function markTurnTerminationOutcome<T extends object>(error: T, outcome: TurnTerminationOutcome): T {
  Object.defineProperty(error, TURN_TERMINATION_OUTCOME, {
    value: outcome,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Marks an error as a genuine turn failure, whatever its message says. */
export function markTurnFailure<T extends object>(error: T): T {
  return markTurnTerminationOutcome(error, 'failure');
}

/** Marks an error as a genuine turn cancellation, whatever its message says. */
export function markTurnCancellation<T extends object>(error: T): T {
  return markTurnTerminationOutcome(error, 'cancellation');
}

/** The provider-boundary stage a sanitized failure came from. */
export type ProviderBoundaryPhase =
  | 'run'
  | 'open'
  | 'resume'
  | 'cancel'
  | 'reset'
  | 'cleanup';

/**
 * Builds the only error shape allowed to cross a provider boundary outward.
 *
 * Native runtime errors carry prompt, tool, path, session and credential text,
 * and hosts log caught errors on default-on and debug signals with recursive
 * serialization — so `cause`, `errors` and enumerable payloads leak just as
 * readily as `message`. This therefore never accepts the original error: the
 * caller states a closed diagnostic code, the phase and a count, and the raw
 * value is dropped at the throw site rather than at the log site.
 *
 * The explicit outcome marker is preserved so the shared classifier still
 * distinguishes a real failure from a cancellation without message sniffing;
 * a failed cancel stays a failure and cannot flush `task_complete`.
 */
export function createSanitizedBoundaryFailure(params: Readonly<{
  provider: string;
  phase: ProviderBoundaryPhase;
  code: string;
  count?: number;
  outcome?: TurnTerminationOutcome;
}>): Error {
  const count = params.count ?? 1;
  const error = new Error(
    `[${params.provider}] ${params.phase} failed (${params.code}${count > 1 ? `x${count}` : ''})`,
  );
  return markTurnTerminationOutcome(error, params.outcome ?? 'failure');
}

/**
 * Finds an explicit outcome marker on an error or its nested causes.
 *
 * Wrapping is normal: a provider aggregates a native failure into a shutdown or
 * cancellation-shaped envelope. The nearest marker wins, so an explicitly marked
 * cancellation is still a cancellation even when it carries a failed cause.
 */
function findTurnTerminationOutcome(error: unknown, depth = 0): TurnTerminationOutcome | null {
  if (depth > 4 || !error || typeof error !== 'object') return null;
  const direct = readTurnTerminationOutcome(error);
  if (direct) return direct;

  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const nested of errors) {
      const found = findTurnTerminationOutcome(nested, depth + 1);
      if (found) return found;
    }
  }
  return findTurnTerminationOutcome((error as { cause?: unknown }).cause, depth + 1);
}

export function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  // Explicit outcome always outranks message sniffing.
  const marked = findTurnTerminationOutcome(error);
  if (marked) return marked === 'cancellation';
  if (typeof error === 'object' && !Array.isArray(error)) {
    const name = (error as any).name;
    if (typeof name === 'string' && name === 'AbortError') return true;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lowered = String(message ?? '').toLowerCase();
  if (!lowered) return false;
  return lowered.includes('abort') || lowered.includes('cancel');
}

