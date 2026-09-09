/**
 * Why a runner is tearing a turn down.
 *
 * Every abort path in a runner converges on the same `handleAbort` helper, which historically
 * threw this information away. The distinction matters because the two cases want opposite
 * durability: a user who explicitly cancels wants the work abandoned for good, while a process
 * that is merely shutting down wants the session to stay resumable.
 *
 * The intent is established by the *registration site* (an RPC handler, a signal handler, a UI
 * exit hook), never by a request payload, so a remote caller cannot claim to be a shutdown.
 */
export type RunnerAbortIntent =
  /**
   * The user explicitly abandoned this work: the `abort` RPC, an `abort` permission decision, or
   * an in-flight steer cancellation. The work should not come back.
   */
  | 'explicit-cancel'
  /**
   * The runner process is going away: a signal, a kill-session request, an unhandled error, or
   * the terminal UI exiting. The turn stops, but the session stays resumable, because nobody
   * asked for the underlying work to be abandoned.
   */
  | 'shutdown';

/**
 * `shutdown` is the safe default: it never discards a resume pointer. A caller that means to
 * abandon work must say so explicitly.
 */
export const DEFAULT_RUNNER_ABORT_INTENT: RunnerAbortIntent = 'shutdown';

/**
 * Aborts are de-duplicated while one is in flight, so two intents can collide. An explicit
 * cancellation outranks a shutdown: if a user cancels while the process is already stopping, the
 * cancellation still has to take effect, otherwise the shutdown would silently swallow it and the
 * abandoned work would survive.
 */
export function isStrongerRunnerAbortIntent(
  candidate: RunnerAbortIntent,
  current: RunnerAbortIntent,
): boolean {
  return candidate === 'explicit-cancel' && current === 'shutdown';
}
