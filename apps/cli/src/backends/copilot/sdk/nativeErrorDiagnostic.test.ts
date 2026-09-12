/**
 * The native `session.error` body is provider-controlled and untyped, so it can
 * carry credentials, prompt text or terminal control sequences. The diagnostic
 * added for the installed-path investigation interpolated that body verbatim
 * into a default-on log line, which `apps/cli/AGENTS.md` forbids.
 *
 * These tests pin the safe projection: bounded, redacted, control-free, and
 * never the raw payload.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_NATIVE_ERROR_DETAIL_CHARS,
  describeNativeSessionErrorForLog,
} from './nativeErrorDiagnostic';

describe('describeNativeSessionErrorForLog', () => {
  it('reports an absent detail rather than inventing one', () => {
    expect(describeNativeSessionErrorForLog({})).toBe('code=none detail=absent');
  });

  it('keeps a short ordinary message so the failure stays diagnosable', () => {
    const described = describeNativeSessionErrorForLog({ message: 'upstream refused the turn' });

    expect(described).toContain('detail="upstream refused the turn"');
  });

  it('redacts credential-shaped text through the canonical redactor', () => {
    // Synthetic, never a real credential.
    const described = describeNativeSessionErrorForLog({
      message: 'failed: authorization: Bearer sk-test-NOTREAL-0123456789abcdefghij',
    });

    expect(described).not.toContain('sk-test-NOTREAL-0123456789abcdefghij');
    expect(described).toContain('[REDACTED]');
  });

  it('strips control characters so a file log cannot drive the terminal', () => {
    const described = describeNativeSessionErrorForLog({
      message: 'boom\u001b[2Jwiped\u0007\r\nnext',
    });

    expect(described).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(described).toContain('boom');
  });

  it('bounds an oversized payload instead of copying it into the sink', () => {
    const described = describeNativeSessionErrorForLog({ message: 'A'.repeat(100_000) });

    expect(described.length).toBeLessThan(MAX_NATIVE_ERROR_DETAIL_CHARS + 200);
    expect(described).toContain('truncated');
    expect(described).toContain('length=100000');
  });

  it('keeps an allowlist-shaped code but drops a free-form one', () => {
    expect(describeNativeSessionErrorForLog({ code: 'session_failed' })).toContain(
      'code=session_failed',
    );
    expect(
      describeNativeSessionErrorForLog({ code: 'authorization: Bearer NOTREAL secret value' }),
    ).toContain('code=none');
  });

  // IQE-01: character-class admission is not secret redaction. A synthetic
  // GitHub token is made only of characters the shape allows, so it passed the
  // regex and was logged verbatim to file, console and the remote sink. Codes
  // must clear canonical credential rejection BEFORE shape admission.
  it('rejects a credential-shaped code instead of admitting it by character class', () => {
    // Synthetic, never a real credential.
    const syntheticGithubToken = `ghp_${'A'.repeat(36)}`;
    const described = describeNativeSessionErrorForLog({ code: syntheticGithubToken });

    expect(described).not.toContain(syntheticGithubToken);
    expect(described).toContain('code=none');
  });

  it('rejects other named credential prefixes and long opaque runs', () => {
    for (const synthetic of [
      `github_pat_${'B'.repeat(40)}`,
      `glpat-${'C'.repeat(20)}`,
      `xoxb-${'1'.repeat(24)}`,
      `sk-${'D'.repeat(32)}`,
      `AKIA${'E'.repeat(16)}`,
      `9f3b2c7d4e8a1b6c5d0e7f2a`,
    ]) {
      const described = describeNativeSessionErrorForLog({ code: synthetic });
      expect(described).not.toContain(synthetic);
      expect(described).toContain('code=none');
    }
  });

  it('still retains genuinely useful non-sensitive codes', () => {
    for (const code of [
      'session_failed',
      'ECONNRESET',
      'rate_limit_exceeded',
      'copilot.session.error',
      'HTTP-503',
    ]) {
      expect(describeNativeSessionErrorForLog({ code })).toContain(`code=${code}`);
    }
  });

  // IQE DOC-01: the original intent is to prevent control SEQUENCES reaching a
  // sink. An 8-bit CSI introducer (U+009B) drives a terminal exactly like the
  // 7-bit ESC[ form, so the C1 range must be stripped as well as C0/DEL.
  it('strips C1 control characters including the 8-bit CSI introducer', () => {
    const described = describeNativeSessionErrorForLog({
      message: 'boom\u009b2Jwiped\u0085more\u009fend',
    });

    expect(described).not.toMatch(/[\u0080-\u009f]/u);
    expect(described).toContain('boom');
    expect(described).toContain('end');
  });

  it('never returns the raw non-string payload shape', () => {
    const described = describeNativeSessionErrorForLog({ message: { nested: 'PROMPT-TEXT' } });

    expect(described).not.toContain('PROMPT-TEXT');
    expect(described).toBe('code=none detail=absent');
  });
});
