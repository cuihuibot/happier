import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensureLocalFirstPartyComponentCommandMock, runCommandCaptureMock } = vi.hoisted(() => ({
  ensureLocalFirstPartyComponentCommandMock: vi.fn(async () => '/fake/happier'),
  runCommandCaptureMock: vi.fn(),
}));

vi.mock('./localFirstPartyCommand.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./localFirstPartyCommand.js')>();
  return {
    ...actual,
    ensureLocalFirstPartyComponentCommand: ensureLocalFirstPartyComponentCommandMock,
  };
});

vi.mock('./taskRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskRuntime.js')>();
  return {
    ...actual,
    runCommandCapture: runCommandCaptureMock,
  };
});

import { readAuthStatus } from './localDaemonCli.js';

afterEach(() => {
  vi.clearAllMocks();
});

function cliResult(params: Readonly<{ status: number; stdout: string; stderr?: string }>) {
  return {
    status: params.status,
    stdout: params.stdout,
    stderr: params.stderr ?? '',
  };
}

describe('readAuthStatus', () => {
  it('reports the authenticated machine when the CLI exits zero with a success envelope', async () => {
    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 0,
      stdout: '{"ok":true,"kind":"auth_status","data":{"authenticated":true,"machineId":" machine-1 "}}\n',
    }));

    await expect(readAuthStatus()).resolves.toEqual({
      authenticated: true,
      machineId: 'machine-1',
    });
  });

  it('reports an unauthenticated machine for the explicit not_authenticated envelope on a nonzero exit', async () => {
    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 1,
      stdout: '{"ok":false,"kind":"auth_status","error":{"code":"not_authenticated"}}\n',
    }));

    await expect(readAuthStatus()).resolves.toEqual({
      authenticated: false,
      machineId: null,
    });
  });

  it('fails closed when the CLI exits nonzero but prints a success-shaped envelope', async () => {
    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 1,
      stdout: '{"ok":true,"data":{"authenticated":true,"machineId":"machine-1"}}\n',
      stderr: 'relay unreachable\n',
    }));

    await expect(readAuthStatus()).rejects.toMatchObject({
      code: 'cli_command_failed',
    });
  });

  it('fails closed when a nonzero exit prints an unexpected or malformed envelope', async () => {
    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 2,
      stdout: '{"ok":false,"error":{"code":"not_authenticated"}}\n',
      stderr: 'unexpected failure\n',
    }));
    await expect(readAuthStatus()).rejects.toMatchObject({
      code: 'cli_command_failed',
    });

    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 2,
      stdout: 'not json at all\n',
      stderr: 'unexpected failure\n',
    }));
    await expect(readAuthStatus()).rejects.toMatchObject({
      code: 'cli_command_failed',
    });
  });

  it('fails closed on a zero exit whose failure envelope is not not_authenticated', async () => {
    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 0,
      stdout: '{"ok":false,"kind":"auth_status","error":{"code":"relay_unreachable"}}\n',
    }));

    await expect(readAuthStatus()).rejects.toMatchObject({
      code: 'relay_unreachable',
    });
  });

  it('rejects a zero-exit response that is not a JSON object', async () => {
    runCommandCaptureMock.mockResolvedValue(cliResult({
      status: 0,
      stdout: 'not json at all\n',
    }));

    await expect(readAuthStatus()).rejects.toMatchObject({
      code: 'invalid_cli_response',
    });
  });

  it('rejects zero-exit auth responses without an explicit boolean authenticated value', async () => {
    for (const stdout of [
      '{}\n',
      '{"ok":true,"kind":"server_configure","data":{}}\n',
      '{"ok":true,"kind":"auth_status","data":{}}\n',
      '{"ok":true,"kind":"auth_status","data":{"authenticated":"yes"}}\n',
    ]) {
      runCommandCaptureMock.mockResolvedValue(cliResult({ status: 0, stdout }));
      await expect(readAuthStatus()).rejects.toMatchObject({
        code: 'invalid_cli_response',
      });
    }
  });
});
