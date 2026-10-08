import { ExecutionRunDisplaySchema } from './executionRunStartRequest.js';
import { ExecutionRunPublicStateSchema } from './executionRuns.js';
import { BackendTargetRefSchema } from './backendTargets/backendTargetRef.js';

/** Display metadata wins; only acknowledged native identity can supply a specialist fallback. */
export function resolveExecutionRunDisplayTitle(run: Readonly<{
  display?: unknown;
  nativeSelection?: unknown;
  backendTarget?: unknown;
}>): string | null {
  const display = ExecutionRunDisplaySchema.safeParse(run.display);
  if (display.success) {
    const title = display.data.title?.trim() || display.data.participantLabel?.trim();
    if (title) return title;
  }
  const selection = ExecutionRunPublicStateSchema.shape.nativeSelection.safeParse(run.nativeSelection);
  if (!selection.success || !selection.data) return null;
  const target = BackendTargetRefSchema.safeParse(run.backendTarget);
  const agentId = selection.data.agentId.trim();
  if (target.success) {
    const backendId = target.data.kind === 'builtInAgent' ? target.data.agentId : target.data.backendId;
    if (backendId === agentId) return null;
  }
  return agentId ? agentId.slice(0, 200) : null;
}

export function resolveExecutionRunTranscriptDisplayTitle(input: unknown, result: unknown): string | null {
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const inputRecord = asRecord(input);
  const resultRecord = asRecord(result);
  const legacyLabel = (record: Record<string, unknown>) =>
    typeof record.label === 'string' ? record.label.trim() || null : null;
  return legacyLabel(inputRecord)
    ?? legacyLabel(resultRecord)
    ?? resolveExecutionRunDisplayTitle(inputRecord)
    ?? resolveExecutionRunDisplayTitle(resultRecord);
}
