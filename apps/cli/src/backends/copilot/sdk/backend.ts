/**
 * Copilot SDK backend (experimental spike, host-only).
 *
 * Implements the canonical {@link AcpRuntimeBackend} boundary on top of the
 * pinned `@github/copilot-sdk`, so the existing `createAcpRuntime` owner keeps
 * ownership of transcript persistence, turn completion (`task_complete`),
 * permission coordination, vendor-resume identity and cleanup. This module only
 * translates native session events into the normalized `AgentMessage` union and
 * drives the native session; it deliberately owns none of those decisions.
 *
 * Not shipped: reachable only through the explicit experiment selection in
 * `../runtimeFactory`; ACP remains the default for every other session.
 */
import { appendFileSync } from 'node:fs';

import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

import type { AcpPromptSubmissionEvidence } from '@/agent/acp/AcpBackend';
import { createSanitizedBoundaryFailure, markTurnFailure } from '@/agent/executionRuns/runtime/turnDelivery';
import type {
  PermissionRequest as SdkPermissionRequest,
  ResumeSessionConfig,
  SessionConfig,
} from '@github/copilot-sdk';

import type { McpServerConfig } from '@/agent';
import type { AgentMessage, AgentMessageHandler } from '@/agent/core/AgentMessage';
import { logger } from '@/ui/logger';

/** Decision shape accepted by the pinned SDK permission callback. */
export type SdkPermissionDecision =
  | { kind: 'approve-once' }
  | { kind: 'reject'; feedback: string };

/** Host callback that resolves one native permission request. */
export type SdkPermissionBridge = (
  permissionId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<SdkPermissionDecision>;

/**
 * One sanitized post-request usage observation; never a proven spend cap.
 *
 * Only typed accounting fields are retained. The raw native payload is
 * deliberately NOT kept, so no prompt, tool or credential content can reach an
 * evidence sink through this record.
 */
export type SdkUsageObservation = Readonly<{
  observedAtMs: number;
  apiCallId?: string;
  model?: string;
  /** Native attribution for autonomous calls, e.g. "sub-agent"/"mcp-sampling". */
  initiator?: string;
  /** Native call classification, e.g. "conversation-subagent". */
  interactionType?: string;
  /** Canonical token map; absent counters stay absent rather than becoming 0. */
  tokens?: Readonly<Record<string, number>>;
}>;

export type CopilotSdkBackendParams = Readonly<{
  cliPath: string;
  directory: string;
  model?: string;
  /** Session config/state directory; keeps spike state out of the native home. */
  configDirectory?: string;
  /**
   * Strict positive integer credit threshold. The native runtime enforces a
   * minimum of 30 and treats this as a soft, post-paid stop threshold — it is
   * not a hard currency cap and does not bound concurrent in-flight starts.
   */
  maxAiCredits?: number;
  /** Host-resolved per-session environment (carries HAPPIER_SESSION_ID). */
  processEnv?: NodeJS.ProcessEnv;
  /** Host-resolved MCP servers for the native session. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Fail-closed stop after this many observed native model calls.
   *
   * The native `maxAiCredits` floor is a soft, post-paid threshold and does not
   * bound concurrent starts, so a bounded experiment needs a host-side refusal
   * rather than accounting that merely records an overrun after the fact.
   */
  modelCallCeiling?: number;
  /**
   * Explicit fixture path for the durable sanitized accounting sink.
   *
   * Default-off. In-process observations are invisible to an external live
   * driver, which can only inspect state after the owned runtime is gone, so
   * accounting has to be durable to be verifiable at all. Only the allowlisted
   * counters in {@link NATIVE_USAGE_COUNTERS} plus call identity are written;
   * never prompts, tool payloads or credentials.
   */
  usageSinkPath?: string;
  /**
   * Upper bound for a single native turn when the caller supplies none.
   *
   * The canonical owner calls `waitForResponseComplete()` with no argument
   * (`createAcpRuntime.ts:2184,2565`), so a caller-supplied timeout never
   * arrives in the consumed vertical. Unlike the Codex/PI backends this one has
   * no native liveness channel, so without a self-imposed bound a native
   * runtime that dies without emitting `session.idle` would hang the host
   * prompt loop indefinitely.
   */
  settlementTimeoutMs?: number;
  /**
   * Bound for the SDK's graceful `stop()` before escalating to `forceStop()`.
   *
   * The pinned graceful stop retries `disconnect` and awaits child exit, so it
   * can take a while or never settle. Cleanup must not inherit that.
   */
  gracefulStopTimeoutMs?: number;
  onPermissionRequest?: SdkPermissionBridge;
  /** Injection seam for the genuine external SDK transport (tests only). */
  createClient?: (options: Record<string, unknown>) => CopilotClient;
}>;

/**
 * Default bound for one native turn, matching the 60s the pre-repair spike
 * runtime applied. Kept explicit so a stuck native runtime surfaces as a
 * visible aborted turn rather than a silent hang.
 */
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60_000;

/**
 * Validates the native credit threshold strictly.
 *
 * A prefix parse (`"30abc"`) or a fractional value silently truncated to zero
 * would disable the guard while appearing configured, so every non
 * positive-integer value is rejected loudly instead.
 */
export function resolveMaxAiCredits(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Copilot SDK backend: maxAiCredits must be a positive integer, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Projects a pinned SDK permission request onto the tool name and arguments the
 * canonical Happier permission owner expects.
 *
 * The pinned `PermissionRequest` is a `kind`-discriminated union; only the `mcp`
 * variant names a real tool. Every other variant reports its `kind` and forwards
 * its descriptive fields, so a request is never surfaced as an empty `unknown`.
 */
export function describeSdkPermissionRequest(request: SdkPermissionRequest): {
  nativeToolCallId: string | null;
  toolName: string;
  input: Record<string, unknown>;
} {
  const record: Record<string, unknown> =
    request !== null && typeof request === 'object' ? { ...(request as object) } : {};
  const kind = typeof record.kind === 'string' ? record.kind : undefined;
  const mcpToolName =
    kind === 'mcp' && typeof record.toolName === 'string' ? record.toolName : undefined;
  const nativeToolCallId =
    typeof record.toolCallId === 'string' && record.toolCallId.length > 0
      ? record.toolCallId
      : null;

  const { toolCallId: _omitted, ...input } = record;
  return { nativeToolCallId, toolName: mcpToolName ?? kind ?? 'unknown', input };
}

/**
 * Loose structural view of a native session event.
 *
 * `data` stays `unknown` so the concrete SDK `SessionEvent` union remains
 * assignable to this handler shape without a suppressing cast; it is narrowed
 * once below before any field is read.
 */
type NativeEvent = Readonly<{ type: string; data?: unknown }>;

/** Narrows an untyped native event payload to a readable record exactly once. */
function nativeEventData(event: NativeEvent): Record<string, unknown> {
  return event.data !== null && typeof event.data === 'object'
    ? (event.data as Record<string, unknown>)
    : {};
}

/**
 * Reads the optional pinned tool-failure detail.
 *
 * `ToolExecutionCompleteError.message` is required when the object is present;
 * `code` and `remediation` are optional. Only the safe descriptive fields are
 * carried so a failure reason reaches consumers without forwarding an arbitrary
 * native payload.
 */
function readToolErrorDetail(
  value: unknown,
): Readonly<{ message: string; code?: string }> | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : null;
  if (!message) return null;
  return { message, ...(typeof record.code === 'string' ? { code: record.code } : {}) };
}

/**
 * Native usage counters this backend is willing to retain, and the canonical
 * telemetry field each one maps to.
 *
 * This is the single allowlist for accounting: no native payload key outside
 * it reaches an observation, the canonical transcript sink or the durable
 * accounting sink, so prompt, tool and credential content cannot leak through
 * usage reporting. `totalTokens` has no canonical telemetry field and is
 * retained for accounting only.
 */
const NATIVE_USAGE_COUNTERS = [
  ['inputTokens', 'input'],
  ['outputTokens', 'output'],
  ['totalTokens', null],
  ['cacheReadTokens', 'cache_read'],
  ['cacheWriteTokens', 'cache_creation'],
  ['reasoningTokens', 'thought'],
] as const satisfies ReadonlyArray<readonly [string, string | null]>;

/** Reads the allowlisted native counters, keeping absent counters absent. */
function readNativeUsageCounters(data: Record<string, unknown>): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const [nativeField] of NATIVE_USAGE_COUNTERS) {
    const value = data[nativeField];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      counters[nativeField] = value;
    }
  }
  return counters;
}

/**
 * Maps pinned `AssistantUsageData` camelCase counters onto the nested `tokens`
 * map the canonical telemetry owner accepts.
 *
 * Unknown or absent counters stay absent rather than becoming zero, so a
 * missing cost is never reported as a free call.
 */
function normalizeNativeUsageTokens(
  data: Record<string, unknown>,
): Record<string, number> | null {
  const counters = readNativeUsageCounters(data);
  const tokens: Record<string, number> = {};
  for (const [nativeField, canonicalField] of NATIVE_USAGE_COUNTERS) {
    if (canonicalField === null) continue;
    const value = counters[nativeField];
    if (value !== undefined) tokens[canonicalField] = value;
  }
  return Object.keys(tokens).length > 0 ? tokens : null;
}

/**
 * Translates one native session event into normalized agent messages.
 *
 * Exported for deterministic projection tests. Returns an array because a single
 * native event may carry both transcript content and telemetry.
 */
export function projectNativeEvent(event: NativeEvent): AgentMessage[] {
  const data: Record<string, unknown> = nativeEventData(event);
  switch (event.type) {
    case 'assistant.message': {
      const content = data.content;
      if (typeof content !== 'string' || content.length === 0) return [];
      return [{ type: 'model-output', fullText: content, fullTextScope: 'segment' }];
    }
    case 'tool.execution_start': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : null;
      const toolName = typeof data.toolName === 'string' ? data.toolName : 'unknown';
      if (!callId) return [];
      const args =
        data.arguments !== null && typeof data.arguments === 'object'
          ? (data.arguments as Record<string, unknown>)
          : {};
      return [{ type: 'tool-call', toolName, args, callId }];
    }
    case 'tool.execution_complete': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : null;
      const toolName = typeof data.toolName === 'string' ? data.toolName : 'unknown';
      if (!callId) return [];
      // `success` is REQUIRED in the pinned contract
      // (generated/session-events.d.ts:5837-5912) and `error` is optional, so a
      // failed tool call frequently carries no error object at all. Deriving
      // failure from `error` alone silently published failures as successes.
      const failed = data.success === false;
      const errorDetail = readToolErrorDetail(data.error);
      return [
        {
          type: 'tool-result',
          toolName,
          callId,
          // A failure reason must survive persistence: consumers show the
          // canonical result, not the raw native event.
          result: failed ? { success: false, ...(errorDetail ? { error: errorDetail } : {}) } : (data.result ?? null),
          ...(failed ? { isError: true } : {}),
        },
      ];
    }
    case 'assistant.usage': {
      // Telemetry only: usage must never enter the transcript as model output.
      // The canonical parser (`@/api/session/acpTokenCountUsage`) reads a nested
      // `tokens` map or snake_case fields; the SDK's camelCase fields were
      // dropped entirely, losing every token count.
      const tokens = normalizeNativeUsageTokens(data);
      if (!tokens) return [];
      return [
        {
          type: 'token-count',
          ...(typeof data.model === 'string' ? { model: data.model } : {}),
          tokens,
        },
      ];
    }
    case 'session.error': {
      const message = typeof data.message === 'string' ? data.message : 'native session error';
      return [{ type: 'status', status: 'error', detail: message }];
    }
    case 'session.idle':
      return [{ type: 'status', status: 'idle' }];
    default:
      return [];
  }
}

/**
 * Detects the pinned runtime's non-terminal autopilot idle.
 *
 * Mirrors `session.js:462-481`, where `sendAndWait` settles only on
 * `session.idle` with `mode !== 'autopilot'`. An autopilot idle is emitted
 * between autonomous continuation steps, so treating it as terminal ends the
 * host turn before the final answer exists.
 */
function isAutopilotIdle(data: Record<string, unknown>): boolean {
  return data.mode === 'autopilot';
}

/**
 * Default bound for the SDK's graceful `stop()` before force escalation.
 *
 * Derived from the pinned client's own shutdown shape: it retries `disconnect`
 * three times with backoff and then awaits child exit, so a few seconds is a
 * normal successful stop while a stall must not block host cleanup.
 */
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 5_000;

/** Default bound for forceStop/disconnect/abort settlement. */

/** The awaited external shutdown stages that must each be bounded. */
export type CopilotSdkCleanupPhase =
  | 'graceful-stop'
  | 'force-stop'
  | 'session-disconnect'
  | 'turn-abort';

/**
 * A cleanup failure reduced to non-identifying facts.
 *
 * Native error text can contain prompt, tool, path or session content, so it
 * never reaches the default-on log. The phase, a closed diagnostic code and a
 * count preserve the diagnostic structure without the payload.
 */
export interface CopilotSdkCleanupFailure {
  readonly phase: CopilotSdkCleanupPhase;
  readonly code: 'timeout' | 'rejected' | 'reported-errors' | 'unverified-termination';
  readonly count: number;
}

/** Renders sanitized cleanup failures for a default-on log line. */
export function formatCleanupDiagnostic(
  failures: readonly CopilotSdkCleanupFailure[],
): string {
  return failures.map((f) => `${f.phase}:${f.code}x${f.count}`).join(',');
}

/**
 * What the last shutdown attempt actually achieved.
 *
 * `processExitObserved` is deliberately separate from `forceStopSucceeded`:
 * the pinned `forceStop()` swallows kill errors, so its resolution proves an
 * attempt was made, never that the OS process exited.
 */
export type CopilotSdkShutdownOutcome = Readonly<{
  gracefulStopSucceeded: boolean;
  escalatedToForceStop: boolean;
  forceStopSucceeded: boolean | null;
  processExitObserved: boolean;
}>;

const NO_SHUTDOWN_ATTEMPTED: CopilotSdkShutdownOutcome = {
  gracefulStopSucceeded: false,
  escalatedToForceStop: false,
  forceStopSucceeded: null,
  processExitObserved: false,
};

export function createCopilotSdkBackend(params: CopilotSdkBackendParams) {
  const maxAiCredits = resolveMaxAiCredits(params.maxAiCredits);

  let client: CopilotClient | null = null;
  let lastShutdownOutcome: CopilotSdkShutdownOutcome = NO_SHUTDOWN_ATTEMPTED;
  let session: { sessionId: string; send: (p: string) => Promise<unknown>; abort: () => Promise<void>; disconnect: () => Promise<void>; setModel?: (model: string) => Promise<unknown> } | null = null;
  let disposed = false;
  // Cleanup stages reuse the single canonical settlement bound. When the caller
  // does not configure one they fall back to the graceful-stop default rather
  // than the 60s turn bound: cleanup must not block the host that long.
  const cleanupStageTimeoutMs =
    params.settlementTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
  let cleanupFailures: CopilotSdkCleanupFailure[] = [];
  const recordCleanupFailure = (failure: CopilotSdkCleanupFailure): void => {
    cleanupFailures.push(failure);
  };

  const handlers = new Set<AgentMessageHandler>();
  const usageObservations: SdkUsageObservation[] = [];
  /** Durable-accounting write failures; a nonzero count means incomplete evidence. */
  let usageSinkFailures = 0;
  /**
   * Native permission requests without a native tool call id still need a stable
   * distinct identity; a shared constant would collide in the canonical
   * permission corridor and let one approve-once decision satisfy an unrelated
   * later request.
   */
  let permissionSequence = 0;

  /**
   * Single terminal outcome for the current native turn.
   *
   * Settlement previously had three competing writers (a resolve-only waiter, a
   * timeout that rejected inside `abort().finally`, and no error path at all),
   * so a racing `session.idle` could turn a timeout into success and a
   * `session.error` could hang the host until the bound expired. One
   * first-write-wins latch is the only decision-maker: `error`, `cancelled` and
   * `timedout` are failures, and only a genuine non-autopilot `session.idle`
   * succeeds.
   */
  type TurnOutcome =
    | { kind: 'settled' }
    | { kind: 'failed'; error: Error };
  let turnOutcome: TurnOutcome | null = null;
  let notifyTurnOutcome: (() => void) | null = null;

  const recordTurnOutcome = (outcome: TurnOutcome): void => {
    // First write wins: a later racing signal can never rewrite a terminal
    // failure into success.
    if (turnOutcome) return;
    // Every terminal failure is marked at this one choke point. Without the
    // marker the shared classifier falls back to reading the message, and a
    // failure whose text legitimately mentions "abort" (an aborted turn whose
    // abort also failed) would be misread as a user cancellation, causing the
    // host prompt loop to publish task_complete for a failed turn.
    if (outcome.kind === 'failed') markTurnFailure(outcome.error);
    turnOutcome = outcome;
    notifyTurnOutcome?.();
  };

  const emit = (message: AgentMessage): void => {
    for (const handler of [...handlers]) {
      try {
        handler(message);
      } catch (error) {
        logger.debug('[copilot-sdk] message handler threw (non-fatal)', error);
      }
    }
  };

  const onNativeEvent = (event: NativeEvent): void => {
    const data = nativeEventData(event);
    if (event.type === 'assistant.usage') {
      recordUsageObservation(data);
    }
    for (const message of projectNativeEvent(event)) emit(message);

    // A native error is terminal for the turn. The pinned SDK settles
    // `sendAndWait` on `session.error` without any following idle
    // (session.js:462-481 and the pinned reference test), so waiting for idle
    // here left the host blocked until its own bound expired.
    if (event.type === 'session.error') {
      const message = typeof data.message === 'string' ? data.message : 'native session error';
      recordTurnOutcome({
        kind: 'failed',
        error: new Error(`Copilot SDK backend: native session error: ${message}`),
      });
      return;
    }

    // Only a genuine non-autopilot `session.idle` ends the whole turn.
    // `assistant.idle` fires while background work is still pending, and the
    // pinned runtime also emits `session.idle` with `mode: 'autopilot'` between
    // autonomous continuation steps — treating that as terminal published
    // `task_complete` before the final answer existed.
    if (event.type === 'session.idle' && !isAutopilotIdle(data)) {
      recordTurnOutcome({ kind: 'settled' });
    }
  };

  const buildSessionConfig = (): SessionConfig => ({
    onEvent: onNativeEvent,
    onPermissionRequest: async (request: SdkPermissionRequest) => {
      const described = describeSdkPermissionRequest(request);
      // Each native callback invocation is a DISTINCT authorization request.
      // The pinned SDK keeps its own `requestId` internally and does not pass it
      // to this callback (session.js:628-635,791-807), and `toolCallId` is a
      // tool-execution identity that repeats across separate requests. Reusing
      // it let one approve-once decision silently satisfy a later request with
      // an equal payload in the canonical permission cache, so identity is
      // always freshly minted here and the native tool call is carried
      // separately as correlation only.
      permissionSequence += 1;
      const permissionId = `copilot-sdk-permission-${permissionSequence}`;
      if (!params.onPermissionRequest) {
        return { kind: 'reject', feedback: 'No host permission bridge is configured' };
      }
      return params.onPermissionRequest(permissionId, described.toolName, {
        ...described.input,
        ...(described.nativeToolCallId
          ? { nativeToolCallId: described.nativeToolCallId }
          : {}),
      });
    },
    streaming: false,
    workingDirectory: params.directory,
    // Native file discovery and file hooks are the S1-proven behavior this
    // vertical depends on (repository instructions, file agents and skills, and
    // native hook execution). They are explicit typed session settings
    // (types.d.ts:1921-1927, 2386-2390) and are forwarded here rather than
    // imitated with SDK `customAgents`/hook callbacks.
    enableConfigDiscovery: true,
    enableFileHooks: true,
    ...(params.configDirectory ? { configDirectory: params.configDirectory } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(maxAiCredits ? { sessionLimits: { maxAiCredits } } : {}),
  });

  const ensureClient = (): CopilotClient => {
    if (client) return client;
    // The managed per-session environment belongs to the runtime process. When
    // omitted the SDK inherits ambient `process.env`, which would run native
    // hooks against the wrong Happier session.
    const connectionOptions: Record<string, unknown> = {
      path: params.cliPath,
      ...(params.processEnv ? { env: params.processEnv } : {}),
    };
    client = params.createClient
      ? params.createClient(connectionOptions)
      : new CopilotClient({
          connection: RuntimeConnection.forStdio(connectionOptions as { path: string }),
        });
    return client;
  };

  /**
   * Stops the owned runtime within a bound, escalating to the typed forceStop.
   *
   * The pinned contract makes three failure shapes reachable and all three were
   * observed in test: `stop()` resolving with an `Error[]`, `stop()` rejecting,
   * and `stop()` never settling. Any of them escalates to `forceStop()`, which
   * is the only publicly typed hard-termination primitive. `forceStop()`
   * swallows its own kill errors, so its resolution is recorded as an ATTEMPT,
   * never as observed process exit.
   *
   * The client reference is retained whenever termination is not verifiably
   * complete: the shared reset owner drops its backend reference on failure, so
   * clearing here too would strand the runtime with no remaining handle.
   */
  /**
   * Runs one awaited external shutdown stage under a bound.
   *
   * Every stage that crosses the native boundary — graceful stop, force stop,
   * session disconnect and turn abort — can reject OR never settle. An
   * unbounded await on any of them strands the shared reset owner forever, so
   * each one goes through here. A timeout is recorded as a FAILURE and never
   * as a success shape, and the timer is always cleared so no handle outlives
   * the stage.
   */
  const runBoundedStage = async <T>(
    phase: CopilotSdkCleanupPhase,
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        operation().then((value) => ({ kind: 'value' as const, value })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        }),
      ]);
      if (outcome.kind === 'timeout') {
        recordCleanupFailure({ phase, code: 'timeout', count: 1 });
        return {
          ok: false,
          error: new Error(`native ${phase} did not settle within ${timeoutMs}ms`),
        };
      }
      return { ok: true, value: outcome.value };
    } catch (error) {
      recordCleanupFailure({ phase, code: 'rejected', count: 1 });
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };

  const stopOwnedClient = async (): Promise<Error[]> => {
    const owned = client;
    if (!owned) return [];

    const failures: Error[] = [];
    const gracefulTimeoutMs = params.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;

    const graceful = await runBoundedStage('graceful-stop', gracefulTimeoutMs, () => owned.stop());
    let gracefulStopSucceeded = false;
    if (graceful.ok) {
      const reported = Array.isArray(graceful.value)
        ? graceful.value.filter((entry): entry is Error => entry instanceof Error)
        : [];
      if (reported.length > 0) {
        failures.push(...reported);
        recordCleanupFailure({ phase: 'graceful-stop', code: 'reported-errors', count: reported.length });
      }
      gracefulStopSucceeded = reported.length === 0;
    } else {
      failures.push(graceful.error);
    }

    if (gracefulStopSucceeded) {
      lastShutdownOutcome = {
        gracefulStopSucceeded: true,
        escalatedToForceStop: false,
        forceStopSucceeded: null,
        processExitObserved: false,
      };
      client = null;
      return [];
    }

    // `forceStop()` can itself reject OR never settle, so it is bounded exactly
    // like the graceful stage. An unbounded await here previously stranded the
    // whole shared reset forever.
    const forced = await runBoundedStage('force-stop', cleanupStageTimeoutMs, () => owned.forceStop());
    if (!forced.ok) failures.push(forced.error);

    lastShutdownOutcome = {
      gracefulStopSucceeded: false,
      escalatedToForceStop: true,
      forceStopSucceeded: forced.ok,
      // `forceStop()` swallows its own kill errors and the pinned SDK exposes no
      // process handle or PID on any public surface, so a resolved call is an
      // ATTEMPT, never observed exit. Only a host-owned runtime process could
      // set this to true.
      processExitObserved: false,
    };
    // Escalation is never verified termination, so ownership is NOT released on
    // either branch: a resolved `forceStop()` that did not actually kill the
    // runtime must stay retryable through the same handle, exactly like a
    // rejected one. Releasing it here previously discarded a force operation
    // that would have succeeded on a later attempt.
    if (forced.ok) {
      recordCleanupFailure({ phase: 'force-stop', code: 'unverified-termination', count: 1 });
      failures.push(
        createSanitizedBoundaryFailure({
          provider: 'copilot-sdk',
          phase: 'cleanup',
          code: 'force-stop-unverified-termination',
        }),
      );
    }
    return failures;
  };

  /**
   * Releases the owned runtime during a failed open.
   *
   * Start/load failures must not hide cleanup failures: the caller's original
   * error is preserved as the thrown error while any shutdown failure is
   * reported on the default logger rather than silently dropped.
   */
  const releaseClient = async (): Promise<void> => {
    cleanupFailures = [];
    const failures = await stopOwnedClient();
    if (failures.length > 0) {
      logger.warn(
        `[copilot-sdk] native runtime cleanup failed after a failed open: ${formatCleanupDiagnostic(cleanupFailures)}`,
      );
    }
  };

  const openSession = async (
    open: (c: CopilotClient, config: SessionConfig) => Promise<NonNullable<typeof session>>,
  ) => {
    const active = ensureClient();
    try {
      await active.start();
      const created = await open(active, buildSessionConfig());
      if (!created) throw new Error('Copilot SDK backend: native session was not created');
      session = created;
      return created;
    } catch (error) {
      // A partially started runtime must not survive a failed open.
      await releaseClient().catch(() => {});
      session = null;
      throw error;
    }
  };

  const requireSession = () => {
    if (!session) throw new Error('Copilot SDK backend: session is not started');
    return session;
  };

  /**
   * Fail-closed budget stop. Refuses the next send once the configured number of
   * native model calls has already been observed.
   *
   * This is a SOFT, post-request observational stop, not a hard ceiling: usage
   * is reported after a call completes, so it cannot prevent a call already in
   * flight, bound concurrency, or cap currency.
   */
  const assertModelCallCeiling = (): void => {
    const ceiling = params.modelCallCeiling;
    if (ceiling === undefined) return;
    if (usageObservations.length >= ceiling) {
      throw new Error(
        `Copilot SDK backend: refusing to send, observed model-call ceiling of ${ceiling} reached (${usageObservations.length} observed)`,
      );
    }
  };

  /**
   * Appends one sanitized accounting record to the configured fixture sink.
   *
   * The write is synchronous on purpose: shutdown escalates to `forceStop()`,
   * which SIGKILLs the runtime, and a queued async write would be lost exactly
   * when the record matters most. A failure is counted and reported on a
   * default-on signal rather than swallowed, because silently missing
   * accounting would look identical to no native calls at all.
   */
  const appendUsageSinkRecord = (
    observation: SdkUsageObservation,
    counters: Record<string, number>,
  ): void => {
    const sinkPath = params.usageSinkPath;
    if (sinkPath === undefined || sinkPath === '') return;
    const record = {
      observedAtMs: observation.observedAtMs,
      ...(observation.apiCallId === undefined ? {} : { apiCallId: observation.apiCallId }),
      ...(observation.model === undefined ? {} : { model: observation.model }),
      ...(observation.initiator === undefined ? {} : { initiator: observation.initiator }),
      ...(observation.interactionType === undefined
        ? {}
        : { interactionType: observation.interactionType }),
      ...counters,
    };
    try {
      appendFileSync(sinkPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      usageSinkFailures += 1;
      logger.warn(
        `[copilot-sdk] failed to append usage accounting record to the configured sink (${usageSinkFailures} failed so far); accounting for this run is incomplete`,
        error,
      );
    }
  };

  /**
   * Appends the single terminal accounting record for this runtime.
   *
   * Only sanitized structural fields: the terminal state, the producer's own
   * observation count and its failed-write count. No native text, no payload.
   */
  let usageSinkFinalized = false;
  const appendUsageSinkFinalization = (terminationState: 'terminated' | 'unresolved'): void => {
    const sinkPath = params.usageSinkPath;
    if (sinkPath === undefined || sinkPath === '') return;
    // Exactly one terminal record. A retried dispose must not append a second,
    // because a reader treats multiple terminal records as an untrustworthy
    // sink and would report the whole run as unknown.
    if (usageSinkFinalized) return;
    usageSinkFinalized = true;
    const record = {
      finalized: true,
      terminationState,
      nativeCalls: usageObservations.length,
      usageSinkFailures,
    };
    try {
      appendFileSync(sinkPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      usageSinkFailures += 1;
      logger.warn(
        '[copilot-sdk] failed to append the terminal usage accounting record; external accounting for this run stays unknown',
        error,
      );
    }
  };

  /**
   * Records one sanitized post-request usage observation and enforces the
   * observational stop DURING a turn.
   *
   * A check that only ran before the next top-level send could not stop a
   * native turn that kept issuing internal or background model calls, so the
   * configured bound was unenforceable exactly when it mattered. Only typed,
   * non-sensitive accounting fields are retained: the raw native payload is not
   * kept, so no prompt, tool or credential content can reach an evidence sink.
   */
  const recordUsageObservation = (data: Record<string, unknown>): void => {
    const counters = readNativeUsageCounters(data);
    const observation: SdkUsageObservation = {
      observedAtMs: Date.now(),
      ...(typeof data.apiCallId === 'string' ? { apiCallId: data.apiCallId } : {}),
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
      ...(typeof data.initiator === 'string' ? { initiator: data.initiator } : {}),
      ...(typeof data.interactionType === 'string' ? { interactionType: data.interactionType } : {}),
      ...(() => {
        const tokens = normalizeNativeUsageTokens(data);
        return tokens ? { tokens } : {};
      })(),
    };
    usageObservations.push(observation);
    appendUsageSinkRecord(observation, counters);

    const ceiling = params.modelCallCeiling;
    if (ceiling !== undefined && usageObservations.length >= ceiling) {
      recordTurnOutcome({
        kind: 'failed',
        error: new Error(
          `Copilot SDK backend: observed model-call ceiling of ${ceiling} reached mid-turn (${usageObservations.length} observed); native turn stopped`,
        ),
      });
    }
  };

  /**
   * Publishes canonical ACP submission evidence for the pinned SDK transport.
   *
   * `session.send` is the `session.send` RPC and resolves with the native
   * message id once the runtime has taken custody of the user input
   * (`@github/copilot-sdk@1.0.13` `dist/session.js:448-461`); turn completion is
   * reported separately through `session.idle`/`session.error` events and is
   * awaited by `waitForResponseComplete`. Custody acknowledgement is therefore
   * exactly the condition `AcpBackend.sendPromptWithEvidence` reports as
   * `accepted_without_exact_final_response`.
   *
   * Without this seam `createAcpRuntime.sendPromptToProvider` leaves
   * `submissionEvidence` null, never calls `onProviderPromptAccepted`, and
   * defers provider-input acceptance until the whole turn completes. A turn
   * still pending on a held tool permission then never settles the claimed
   * Pending row, so the user's own message never becomes a canonical transcript
   * message (IQE-SDK-AC08-ANCHOR-001).
   *
   * A native rejection propagates unchanged: acceptance is never manufactured
   * for input the runtime did not take custody of.
   */
  const sendPromptWithEvidence = async (
    _sessionId: string,
    prompt: string,
  ): Promise<AcpPromptSubmissionEvidence> => {
    const active = requireSession();
    assertModelCallCeiling();
    // A new turn starts unsettled; a stale outcome must never satisfy it.
    turnOutcome = null;
    await active.send(prompt);
    return { kind: 'accepted_without_exact_final_response' };
  };

  return {
    startSession: async (initialPrompt?: string): Promise<{ sessionId: string }> => {
      const created = await openSession((c, config) => c.createSession(config));
      logger.debug('[copilot-sdk] session started');
      if (initialPrompt) {
        assertModelCallCeiling();
        await created.send(initialPrompt);
      }
      return { sessionId: created.sessionId };
    },

    /**
     * Vendor-level resume through the pinned typed API. `createSession` has no
     * supported resume field, so a resume must never be routed through it: the
     * runtime would silently mint a new session id and the transcript would fork.
     */
    loadSession: async (sessionId: string): Promise<{ sessionId: string }> => {
      const created = await openSession((c, config) =>
        c.resumeSession(sessionId, config satisfies ResumeSessionConfig),
      );
      if (created.sessionId !== sessionId) {
        await releaseClient().catch(() => {});
        session = null;
        throw new Error(
          `Copilot SDK backend: resume mismatch, requested "${sessionId}" but runtime returned "${created.sessionId}"`,
        );
      }
      return { sessionId: created.sessionId };
    },

    sendPrompt: async (sessionId: string, prompt: string): Promise<void> => {
      await sendPromptWithEvidence(sessionId, prompt);
    },

    sendPromptWithEvidence,

    /**
     * Waits for native full-turn settlement through the single terminal-outcome
     * latch. A timeout aborts and joins the native work; abort acknowledgement
     * alone is explicitly NOT treated as quiescence, because the pinned
     * `session.abort` resolves on RPC acknowledgement without any terminal
     * event (`session.js:1579-1589`).
     */
    waitForResponseComplete: (timeoutMs?: number | null): Promise<void> => {
      const active = requireSession();
      // The canonical owner passes nothing (createAcpRuntime.ts:2184,2565), so
      // the backend must bound the wait itself; it has no native liveness
      // channel to fall back on.
      const effectiveTimeoutMs =
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.trunc(timeoutMs)
          : (params.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS);

      const settlement = (async (): Promise<void> => {
        if (!turnOutcome) {
          let timer: NodeJS.Timeout | undefined;
          await new Promise<void>((resolve) => {
            notifyTurnOutcome = resolve;
            timer = setTimeout(() => {
              // The timeout is itself a terminal failure and is latched BEFORE
              // the abort round trip. Recording it afterwards let a racing idle
              // emitted by abort rewrite the timeout into success.
              recordTurnOutcome({
                kind: 'failed',
                error: new Error(
                  `Copilot SDK backend: native turn timed out after ${effectiveTimeoutMs}ms`,
                ),
              });
            }, effectiveTimeoutMs);
          });
          if (timer) clearTimeout(timer);
          notifyTurnOutcome = null;
        }

        const outcome = turnOutcome;
        if (!outcome || outcome.kind === 'settled') return;

        // A failed turn must not leave native work running. Abort is attempted
        // under a bound (it can hang), its own failure is aggregated rather
        // than swallowed, and it is never presented as proof that the runtime
        // went quiet.
        const aborted = await runBoundedStage('turn-abort', cleanupStageTimeoutMs, () =>
          active.abort(),
        );
        const abortError = aborted.ok ? null : aborted.error;
        throw abortError
          ? new Error(
              `${outcome.error.message}; native abort also failed: ${abortError.message}`,
              { cause: outcome.error },
            )
          : outcome.error;
      })();

      // The canonical owner stores this promise and awaits it on its normal
      // path, but abandons it on some early-return paths. An abandoned
      // rejection would surface as a process-level unhandled rejection, so a
      // benign handler is attached here while real awaiters still observe the
      // failure through the returned promise.
      settlement.catch(() => {});
      return settlement;
    },

    cancel: async (_sessionId: string): Promise<void> => {
      // Explicit user cancellation goes through the SAME bounded terminal stage
      // as a timeout-driven abort. Awaiting the native `abort()` directly let a
      // never-settling cancel strand the shared caller forever, and the raw
      // native rejection reached the host's default-on catch, so the bound and
      // the sanitized envelope are applied here at the boundary.
      const aborted = await runBoundedStage('turn-abort', cleanupStageTimeoutMs, () =>
        requireSession().abort(),
      );
      if (!aborted.ok) {
        throw createSanitizedBoundaryFailure({
          provider: 'copilot-sdk',
          phase: 'cancel',
          code: 'native-abort-unsettled',
        });
      }
    },

    /**
     * Forwards a model change to the native session. The pinned SDK supports
     * this directly, so the host's model semantics are preserved rather than
     * silently discarded; an unsupported runtime surfaces its own error.
     */
    setSessionModel: async (_sessionId: string, modelId: string): Promise<void> => {
      const active = requireSession();
      if (!active.setModel) {
        throw new Error(
          'Copilot SDK backend: the native session does not support changing the model',
        );
      }
      await active.setModel(modelId);
    },

    onMessage: (handler: AgentMessageHandler): void => {
      handlers.add(handler);
    },

    offMessage: (handler: AgentMessageHandler): void => {
      handlers.delete(handler);
    },

    /**
     * Contract cleanup: stops the OWNED RUNTIME, not merely the session.
     *
     * Every step is attempted even when an earlier one fails, because a failed
     * `disconnect` previously skipped `client.stop()` entirely and left the
     * native runtime owned but unreferenced. Failures are aggregated and
     * rethrown: `client.stop()` resolves with an `Error[]` in the pinned
     * contract, so discarding that array reported a failed shutdown as clean.
     * `disposed` latches only after a fully successful cleanup, so a partial
     * failure stays retryable.
     */
    dispose: async (): Promise<void> => {
      if (disposed) return;
      cleanupFailures = [];
      const failures: Error[] = [];
      const active = session;

      // The owned RUNTIME is stopped first, before the observation channel is
      // released. Detaching first left a window between `session.detach` and
      // the end of `client.stop()` in which the native runtime still emitted
      // usage events that nothing was listening for, so a shutdown-time model
      // call silently vanished from the durable accounting record.
      failures.push(...(await stopOwnedClient()));

      session = null;
      turnOutcome = null;
      notifyTurnOutcome = null;
      handlers.clear();

      if (active) {
        // `disconnect()` can hang; an unbounded await here previously prevented
        // even the already-authorized force escalation from being attempted.
        const detached = await runBoundedStage('session-disconnect', cleanupStageTimeoutMs, () =>
          active.disconnect(),
        );
        if (!detached.ok) failures.push(detached.error);
      }

      // ONE truthful terminal predicate, shared with `reportsVerifiedTermination()`
      // and with the durable finalization record. A resolved `forceStop()` is an
      // attempt, not observed exit, so anything that had to escalate stays
      // unresolved for every consumer rather than only for the in-process getter.
      const terminationVerified =
        lastShutdownOutcome.gracefulStopSucceeded && !lastShutdownOutcome.escalatedToForceStop;

      // Durable finalization marker.
      //
      // An external driver reads the sink from another process and cannot see
      // in-process getters, so without this record it cannot distinguish "no
      // native call happened" from "the producer was still running" or "the
      // producer died mid-run". The marker states the terminal state and the
      // producer's own call count so a reader can refuse to trust a truncated
      // or still-growing sink. It is written for the unresolved case too, and
      // before the throw below, because an unresolved shutdown is precisely
      // when a reader most needs to know the count is not final.
      appendUsageSinkFinalization(terminationVerified ? 'terminated' : 'unresolved');

      if (failures.length > 0) {
        // Default-on so the operator sees degraded cleanup, but sanitized:
        // only phase, closed diagnostic code and counts. Native error text may
        // carry prompt, tool, path or session content and never reaches here.
        logger.warn(
          `[copilot-sdk] native runtime cleanup failed: ${formatCleanupDiagnostic(cleanupFailures)}` +
            (lastShutdownOutcome.escalatedToForceStop
              ? ` (escalated to forceStop; forceStop ${lastShutdownOutcome.forceStopSucceeded ? 'resolved' : 'failed'}, process exit NOT verified)`
              : ''),
        );
      }

      if (!terminationVerified) {
        // Cleanup we could not prove is a FAILURE even though its text mentions
        // stopping and aborting; without the explicit marker the shared
        // classifier would read it as a user cancellation and let a failed turn
        // flush task_complete. The thrown value carries no native text, cause or
        // payload, because the shared owner and the host both log it.
        throw createSanitizedBoundaryFailure({
          provider: 'copilot-sdk',
          phase: 'cleanup',
          code: lastShutdownOutcome.escalatedToForceStop
            ? lastShutdownOutcome.forceStopSucceeded
              ? 'force-stop-unverified-termination'
              : 'force-stop-failed'
            : 'graceful-stop-failed',
          count: failures.length,
        });
      }
      disposed = true;
    },

    /** Reports what the last shutdown attempt achieved, without over-claiming. */
    getLastShutdownOutcome: (): CopilotSdkShutdownOutcome => lastShutdownOutcome,

    /**
     * The pinned SDK exposes no process handle or pid on its public surface, so
     * a resolved stop/forceStop is an ATTEMPT, never observed exit. This
     * therefore reports verified termination only when nothing had to be
     * forced; the shared owner uses it to refuse a replacement startup.
     */
    reportsVerifiedTermination: (): boolean =>
      lastShutdownOutcome.gracefulStopSucceeded && !lastShutdownOutcome.escalatedToForceStop,

    /**
     * Post-request usage observations captured from before the first send until
     * shutdown. Native usage events are ephemeral and are never replayable from
     * the persisted log, so absence of observations cannot prove zero spend.
     */
    getUsageObservations: (): readonly SdkUsageObservation[] => [...usageObservations],

    getObservedModelCallCount: (): number => usageObservations.length,

    /**
     * Count of failed durable accounting writes. A live driver must treat a
     * nonzero value as "accounting unknown", never as "no calls happened".
     */
    getUsageSinkFailureCount: (): number => usageSinkFailures,
  };
}
