import type { ExecutionRunServiceResult, WaitForExecutionRunResult } from '@/session/services/executionRuns';

import type { HappierBuiltInToolDispatchResult } from './types';

export function normalizeExecutionRunToolResult(
  result: ExecutionRunServiceResult<unknown> | WaitForExecutionRunResult
    | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>,
): HappierBuiltInToolDispatchResult {
  if (!result.ok) {
    if ('errorCode' in result) {
      return {
        ok: false,
        errorCode: result.errorCode,
        error: result.error,
        ...(result.details === undefined ? {} : { details: result.details }),
      };
    }
    return { ok: false, errorCode: result.code, error: result.message ?? result.code };
  }

  if ('data' in result) {
    return { ok: true, result: result.data };
  }

  const { ok: _ok, ...payload } = result;
  return { ok: true, result: payload };
}
