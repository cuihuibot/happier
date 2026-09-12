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

  it('never returns the raw non-string payload shape', () => {
    const described = describeNativeSessionErrorForLog({ message: { nested: 'PROMPT-TEXT' } });

    expect(described).not.toContain('PROMPT-TEXT');
    expect(described).toBe('code=none detail=absent');
  });
});
