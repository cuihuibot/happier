/**
 * Composed diagnostics regression for `happier session send --wait --json`.
 *
 * A blocked pending delivery used to reach the operator as
 * `{"code":"wait_failed","message":"wait_failed"}`: the service produced a
 * specific typed reason, the CLI action normalization collapsed it to the bare
 * code, and the public serializer echoed that code back as the message. The
 * operator could not tell a blocked delivery from a wait-path exception.
 *
 * These assertions run the REAL command dispatch, the REAL action executor and
 * CLI action deps, and the REAL public envelope serializer. Only the session
 * send service itself is a synthetic fixture, standing in for the external
 * account, provider and server boundary. A helper-level formatting test would
 * not have caught the defect, because every helper involved was already correct
 * in isolation.
 *
 * The disclosure contract under test: only a reason drawn from the closed,
 * deliberately public `PENDING_DELIVERY_BLOCKED_REASONS` vocabulary may be
 * disclosed, rendered through the canonical formatter. Anything absent,
 * unknown, malformed or attacker-shaped must fall back to the pre-existing
 * generic code, and free provider prose must never reach the public envelope.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const sendSessionMessage = vi.fn();

vi.mock('@/session/services/sendSessionMessage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/services/sendSessionMessage')>();
  return { ...actual, sendSessionMessage };
});

const SENTINEL = 'SPIKE-UNSAFE-SENTINEL-9f3a1c';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

async function runSend() {
  const { handleSessionCommand } = await import('./handleSessionCommand');
  const output = captureConsoleJsonOutput();
  try {
    await handleSessionCommand(
      ['send', 'sess-1', 'Hello', '--wait', '--timeout', '60', '--json'],
      { readCredentialsFn: async () => credentials },
    );
    return output.json() as {
      ok: boolean;
      kind: string;
      error?: { code?: string; message?: string };
    };
  } finally {
    output.restore();
  }
}

describe('happier session send: blocked pending-delivery diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discloses the canonical reason for a permitted blocked delivery', async () => {
    sendSessionMessage.mockResolvedValueOnce({
      ok: false,
      code: 'wait_failed',
      blockedDeliveryReason: 'provider_unavailable_before_acceptance',
      message: 'Current turn failed: pending delivery blocked (provider_unavailable_before_acceptance)',
    });

    const parsed = await runSend();

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('session_send');
    // The public code and envelope shape are part of the existing contract.
    expect(parsed.error?.code).toBe('wait_failed');
    expect(parsed.error?.message).toBe(
      'Current turn failed: pending delivery blocked (provider_unavailable_before_acceptance)',
    );
  });

  it.each([
    ['terminal_host_unreachable'],
    ['runtime_disposed_before_delivery'],
    ['payload_too_large'],
  ])('discloses the canonical reason %s', async (reason) => {
    sendSessionMessage.mockResolvedValueOnce({
      ok: false,
      code: 'wait_failed',
      blockedDeliveryReason: reason,
    });

    const parsed = await runSend();

    expect(parsed.error?.code).toBe('wait_failed');
    expect(parsed.error?.message).toBe(
      `Current turn failed: pending delivery blocked (${reason})`,
    );
  });

  it('falls back to the generic code when no blocked reason is present', async () => {
    // This is the wait-path exception shape: same code, no typed reason.
    sendSessionMessage.mockResolvedValueOnce({ ok: false, code: 'wait_failed' });

    const parsed = await runSend();

    expect(parsed.error?.code).toBe('wait_failed');
    expect(parsed.error?.message).toBe('wait_failed');
  });

  it.each([
    ['an unknown vocabulary member', `${SENTINEL}_reason`],
    ['a prose payload', `provider exploded: ${SENTINEL}`],
    ['an empty string', ''],
    ['a non-string', { toString: (): string => SENTINEL }],
  ])('keeps the generic fallback for %s and leaks no sentinel', async (_label, reason) => {
    sendSessionMessage.mockResolvedValueOnce({
      ok: false,
      code: 'wait_failed',
      blockedDeliveryReason: reason,
    });

    const parsed = await runSend();

    expect(parsed.error?.code).toBe('wait_failed');
    expect(parsed.error?.message).toBe('wait_failed');
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });

  it('does not publish the "unknown" catch-all as an authoritative reason', async () => {
    // The upstream projection parser normalizes any unrecognized server reason
    // to 'unknown', so disclosing it would dress an unparsed value up as a
    // diagnosis. The outer built-CLI scenario caught this; the composed unit
    // path did not, because the normalization happens before the service.
    sendSessionMessage.mockResolvedValueOnce({
      ok: false,
      code: 'wait_failed',
      blockedDeliveryReason: 'unknown',
    });

    const parsed = await runSend();

    expect(parsed.error?.code).toBe('wait_failed');
    expect(parsed.error?.message).toBe('wait_failed');
  });

  it('never forwards free provider prose carried on the service message', async () => {
    // `message` legitimately carries provider prose for other wait_failed
    // producers (runtime issue previews). It must not become public here.
    sendSessionMessage.mockResolvedValueOnce({
      ok: false,
      code: 'wait_failed',
      message: `Current turn failed: provider said ${SENTINEL}`,
    });

    const parsed = await runSend();

    expect(parsed.error?.code).toBe('wait_failed');
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });

  it('leaves unrelated failure codes untouched', async () => {
    sendSessionMessage.mockResolvedValueOnce({ ok: false, code: 'session_not_found' });

    const parsed = await runSend();

    expect(parsed.error?.code).toBe('session_not_found');
    expect(parsed.error?.message).toBe('session_not_found');
  });
});
