import { hasNamedCredentialTokenPrefix, redactBugReportSensitiveText } from '@happier-dev/protocol';

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
 * so a provider that misuses `code` as a free-form message fails the check and is
 * dropped rather than truncated into the sink.
 *
 * Shape admission alone is NOT secret rejection: a credential is built from the
 * same characters an identifier uses, so `ghp_<36 chars>` satisfies this pattern.
 * Every code must clear `hasNamedCredentialTokenPrefix` and `OPAQUE_CODE_SEGMENT`
 * first.
 */
const SAFE_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/u;

/**
 * A single unbroken run of 12+ characters mixing letters with digits.
 *
 * Genuine error codes are word-shaped -- `session_failed`, `rate_limit_exceeded`,
 * `copilot.session.error` -- so every delimited segment is a word or a short
 * number. A credential without a documented prefix is instead one long
 * high-entropy run, which no useful code shape produces. Rejecting on segment
 * shape keeps real codes while denying an unprefixed token; the protocol's
 * length heuristic cannot be reused here because it treats `session_failed`
 * itself as a credential.
 */
const OPAQUE_CODE_SEGMENT = /(?=[A-Za-z0-9]{12,}(?![A-Za-z0-9]))(?=[A-Za-z0-9]*\d)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*/u;

// C0 controls, DEL, and the C1 range. An ANSI escape reaching a log file still
// drives the terminal of whoever later `cat`s it, which `apps/cli/AGENTS.md`
// forbids; U+009B is the 8-bit CSI introducer and is equivalent to `ESC [`.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;

/**
 * Admits a native error code only when it is both enum-shaped and not
 * credential-shaped. There is no raw fallback: a code that fails either check is
 * reported as `none`.
 */
function describeNativeErrorCode(rawCode: unknown): string {
  if (typeof rawCode !== 'string') return 'none';
  // Canonical rejection runs BEFORE shape admission: a bare token standing alone
  // as a field value carries no key context for the redactor to rewrite, so
  // character-class admission would pass a real credential through untouched.
  if (hasNamedCredentialTokenPrefix(rawCode)) return 'none';
  if (OPAQUE_CODE_SEGMENT.test(rawCode)) return 'none';
  if (redactBugReportSensitiveText(rawCode) !== rawCode) return 'none';
  return SAFE_CODE_SHAPE.test(rawCode) ? rawCode : 'none';
}

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
  const code = describeNativeErrorCode(data.code);

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
