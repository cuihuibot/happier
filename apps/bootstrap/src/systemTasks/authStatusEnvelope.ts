import * as systemTasks from '@happier-dev/cli-common/systemTasks';

export type AuthStatusFailureEnvelope =
  | Readonly<{ outcome: 'notAuthenticated' }>
  | Readonly<{ outcome: 'unavailable'; errorCode: string }>;

/**
 * Classifies an `ok: false` envelope printed by `happier auth status --json`.
 *
 * The command reports a missing session as structured stdout with a nonzero exit code,
 * so callers must read the envelope rather than the exit status. Returns `null` when the
 * value is not an auth-status failure envelope, which keeps callers fail-closed.
 */
export function classifyAuthStatusFailureEnvelope(parsed: unknown): AuthStatusFailureEnvelope | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Readonly<{ ok?: unknown; kind?: unknown; error?: unknown }>;
  if (record.ok !== false || record.kind !== 'auth_status') {
    return null;
  }
  const error = record.error && typeof record.error === 'object' ? record.error as Readonly<{ code?: unknown }> : null;
  const errorCode = typeof error?.code === 'string' ? error.code.trim() : '';
  return errorCode === 'not_authenticated'
    ? { outcome: 'notAuthenticated' }
    : { outcome: 'unavailable', errorCode };
}

export function createAuthStatusUnavailableError(errorCode: string): Error {
  return new systemTasks.SystemTaskExecutionError(
    errorCode || 'auth_status_unavailable',
    'Could not determine authentication status for the selected Relay.',
  );
}
