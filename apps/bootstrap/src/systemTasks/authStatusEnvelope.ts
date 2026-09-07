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

export function parseAuthStatusSuccessEnvelope(parsed: unknown): Readonly<{
  authenticated: boolean;
  machineId: string | null;
}> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Readonly<{ ok?: unknown; kind?: unknown; data?: unknown }>;
  if (record.ok !== true || record.kind !== 'auth_status' || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
    return null;
  }
  const data = record.data as Readonly<{ authenticated?: unknown; machineId?: unknown }>;
  if (typeof data.authenticated !== 'boolean') {
    return null;
  }
  return {
    authenticated: data.authenticated,
    machineId: typeof data.machineId === 'string' && data.machineId.trim() ? data.machineId.trim() : null,
  };
}

export function createAuthStatusUnavailableError(errorCode: string): Error {
  return new systemTasks.SystemTaskExecutionError(
    errorCode || 'auth_status_unavailable',
    'Could not determine authentication status for the selected Relay.',
  );
}
