/**
 * Copilot SDK runtime selection (experimental spike).
 *
 * Precedence is fixed and fail-closed:
 *
 * | Durable affinity          | Origin / opt-in                  | Result |
 * |---------------------------|----------------------------------|--------|
 * | Valid SDK                 | any origin, flag on or off       | SDK (reopen same vendor session) |
 * | Valid ACP                 | any origin, flag on or off       | ACP |
 * | Present malformed/unknown | any                              | typed refusal before launch (raised by the reader) |
 * | Absent                    | authoritatively created + opt-in | SDK |
 * | Absent                    | existing / unknown / no opt-in   | ACP |
 *
 * Durable affinity outranks the flag so a bound session never changes transport,
 * and the flag alone can never move a session whose origin is not authoritative:
 * an older server that omits the discriminator, or an attach path that has none,
 * yields `unknown`, which is an explicit ACP outcome with a diagnostic rather
 * than a claimed SDK selection.
 */
import type { SessionLaunchOrigin } from '@/api/types';

export type CopilotRuntimeKind = 'acp' | 'sdk';

const EXPERIMENT_ENV_KEY = 'HAPPIER_COPILOT_SDK_EXPERIMENT';

export function resolveCopilotRuntimeKind(
  env: NodeJS.ProcessEnv,
  options?: Readonly<{
    /**
     * Durably recorded backend transport, when this session already has one.
     *
     * `null` means no descriptor was ever written. A present-but-unreadable
     * descriptor never reaches here: the reader refuses it.
     */
    existingBackendAffinity?: CopilotRuntimeKind | null;
    /**
     * Authoritative create-or-load origin reported by the server for this launch.
     *
     * Absent or `'unknown'` is not evidence of a new session. Metadata shape,
     * session flavor, vendor id and attachment state cannot substitute for it.
     */
    sessionLaunchOrigin?: SessionLaunchOrigin;
    /** Receives a default-on explanation when an opt-in could not be honored. */
    onDiagnostic?: (message: string) => void;
  }>,
): CopilotRuntimeKind {
  const affinity = options?.existingBackendAffinity;
  if (affinity === 'acp' || affinity === 'sdk') return affinity;

  const raw = env[EXPERIMENT_ENV_KEY];
  const optedIn = raw === '1' || raw === 'true';
  if (!optedIn) return 'acp';

  const origin = options?.sessionLaunchOrigin ?? 'unknown';
  if (origin === 'created') return 'sdk';

  // The operator asked for the SDK and is not getting it: say why, rather than
  // letting the run look like a successful SDK selection.
  options?.onDiagnostic?.(
    `Copilot SDK experiment requested but not applied: session launch origin is "${origin}", ` +
      'and the SDK runtime may only be selected for an authoritatively created session. ' +
      'Continuing on ACP.',
  );
  return 'acp';
}

export function assertNoSilentRuntimeFallback(params: {
  selected: CopilotRuntimeKind;
  actual: CopilotRuntimeKind;
}): void {
  if (params.selected !== params.actual) {
    throw new Error(
      `Copilot runtime fallback is not permitted: selected ${params.selected} but resolved ${params.actual}`,
    );
  }
}
