import { redactBugReportSensitiveText } from '@happier-dev/protocol';

/**
 * Upper bound on the native detail copied into a log sink.
 *
 * The detail is diagnostic context, not a transcript: a bound keeps a large
 * provider payload out of the file sink (and out of the optional unencrypted
 * remote forwarder that `logger.logToFile` fans out to).
 */
export const MAX_NATIVE_ERROR_DETAIL_CHARS = 300;

/**
 * A native error code is only useful if it is a short, enum-shaped token. The
 * shape is deliberately narrow -- no whitespace, quotes or control characters --
 * so a provider that misuses `code` as a free-form message (or as a credential
 * carrier) fails the check and is dropped rather than truncated into the sink.
 */
const SAFE_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/u;

// C0 and C7 control characters. An ANSI escape reaching a log file still drives
// the terminal of whoever later `cat`s it, which `apps/cli/AGENTS.md` forbids.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/gu;

/**
 * Projects a provider-controlled `session.error` body into a log-safe string.
 *
 * The native event body is untyped and attacker-influenced: it can carry
 * credentials, prompt text or terminal control sequences. This mirrors the
 * closed-code convention already used at this boundary by
 * `createSanitizedBoundaryFailure` -- the sink learns that the native runtime
 * failed the turn plus a bounded, redacted projection, never the raw payload.
 *
 * The unabridged message is still delivered to the caller-facing turn outcome,
 * which the canonical session-issue owner sanitizes for display; this helper
 * governs only what is durably logged.
 */
export function describeNativeSessionErrorForLog(data: Readonly<Record<string, unknown>>): string {
  const rawCode = data.code;
  const code = typeof rawCode === 'string' && SAFE_CODE_SHAPE.test(rawCode) ? rawCode : 'none';

  const rawMessage = data.message;
  if (typeof rawMessage !== 'string' || rawMessage === '') {
    return `code=${code} detail=absent`;
  }

  // Redact first: the canonical redactor matches credential shapes that a later
  // truncation could otherwise split into an unmatched, still-sensitive prefix.
  const redacted = redactBugReportSensitiveText(rawMessage);
  const flattened = redacted.replace(CONTROL_CHARACTERS, ' ').trim();
  const bounded =
    flattened.length > MAX_NATIVE_ERROR_DETAIL_CHARS
      ? `${flattened.slice(0, MAX_NATIVE_ERROR_DETAIL_CHARS)}…`
      : flattened;

  const truncated = flattened.length > MAX_NATIVE_ERROR_DETAIL_CHARS;
  return `code=${code} detail="${bounded}"${truncated ? ` truncated length=${rawMessage.length}` : ''}`;
}
