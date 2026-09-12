/**
 * End-to-end sink contract for the Copilot runtime diagnostics added by the
 * installed-path investigation.
 *
 * The earlier revision of those diagnostics asserted only that `logger.info` /
 * `logger.warn` had been called. That is exactly the gap that let two real
 * defects through: both methods write to the console BEFORE consulting the file
 * threshold, so the diagnostics reached the provider terminal on every session
 * and survived `HAPPIER_LOG_LEVEL=silent`; and the native branch interpolated
 * the provider-controlled `session.error` body verbatim.
 *
 * `apps/cli/AGENTS.md` forbids both ("Do not emit debug output to stdout/stderr
 * in agent-session paths" / "Never log secrets, tokens, ..."), so these tests
 * drive the REAL logger against a REAL file under an owned temporary HOME while
 * capturing REAL stdout/stderr. No spy stands in for a sink.
 */
import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const wire = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  create: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
  connection: vi.fn(),
}));

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: { forStdio: wire.connection },
  CopilotClient: class {
    start = vi.fn(async () => {});
    stop = wire.stop;
    createSession = wire.create;
    resumeSession = wire.resume;
  },
}));

// Synthetic hostile payload: a fake credential shape, an ANSI erase sequence and
// a bell. Never a real secret.
const HOSTILE_TOKEN = 'sk-test-NOTREAL-0123456789abcdefghij';
// Synthetic GitHub-shaped token placed in `code`, which is admitted separately
// from `message`. Never a real credential.
const HOSTILE_CODE = `ghp_${'A'.repeat(36)}`;
const HOSTILE_NATIVE_MESSAGE = `authorization: Bearer ${HOSTILE_TOKEN}\u001b[2J\u0007\u009b2J upstream refused`;

const SELECTION_MARKER = 'runtime selection resolved';
const NATIVE_MARKER = 'native session error';

describe('copilot runtime diagnostics sink contract', () => {
  const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let tempDir: string;
  let console_: ReturnType<typeof captureConsoleText> | null = null;

  beforeEach(() => {
    envScope = createEnvKeyScope(envKeys);
    tempDir = createTempDirSync('happier-cli-copilot-diagnostics-');
    vi.clearAllMocks();
    wire.config = null;
    wire.stop.mockImplementation(async () => []);
    wire.create.mockImplementation(async (config: Record<string, unknown>) => {
      wire.config = config;
      return {
        sessionId: 'diagnostic-native-session',
        send: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {}),
      };
    });
  });

  afterEach(() => {
    console_?.restore();
    console_ = null;
    removeTempDirSync(tempDir);
    envScope.restore();
  });

  /**
   * The file threshold is resolved once in the logger constructor, so the level
   * must be installed before the module graph is rebuilt.
   */
  async function loadAt(level: 'default' | 'debug' | 'silent') {
    envScope.patch({
      HAPPIER_HOME_DIR: tempDir,
      DEBUG: undefined,
      HAPPIER_LOG_LEVEL: level === 'default' ? undefined : level,
    });
    vi.resetModules();
    const { logger } = await import('@/ui/logger');
    const { createCopilotRuntime } = await import('@/backends/copilot/runtimeFactory');
    const { createCopilotSdkBackend } = await import('@/backends/copilot/sdk/backend');
    console_ = captureConsoleText();
    return { logger, createCopilotRuntime, createCopilotSdkBackend };
  }

  const baseParams = () => ({
    directory: '/tmp/diagnostics',
    machineId: 'machine-diagnostics',
    session: { getMetadataSnapshot: () => ({}) },
    messageBuffer: { addMessage: vi.fn() },
    mcpServers: [],
    permissionHandler: { handleToolCall: vi.fn() },
    onThinkingChange: vi.fn(),
    getPermissionMode: () => 'default',
    processEnv: {} as NodeJS.ProcessEnv,
    sessionLaunchOrigin: 'created' as const,
  });

  function fileText(logger: { getLogPath: () => string; flushSync: () => void }): string {
    logger.flushSync();
    const path = logger.getLogPath();
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  async function emitNativeError(
    createCopilotSdkBackend: typeof import('@/backends/copilot/sdk/backend').createCopilotSdkBackend,
    message: unknown,
    code?: unknown,
  ): Promise<void> {
    const backend = createCopilotSdkBackend({
      cliPath: '/diagnostics/never-launch',
      directory: '/tmp/diagnostics',
      createClient: () =>
        ({
          start: vi.fn(async () => {}),
          stop: wire.stop,
          createSession: wire.create,
          resumeSession: wire.resume,
        }) as never,
    } as never);
    await backend.startSession();
    const onEvent = wire.config?.onEvent;
    if (typeof onEvent !== 'function') throw new Error('native transport is not open');
    (onEvent as (event: { type: string; data: unknown }) => void)({
      type: 'session.error',
      data: code === undefined ? { message } : { message, code },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await backend.dispose().catch(() => {});
  }

  it('records the runtime selection in the log file and never on the console', async () => {
    const { logger, createCopilotRuntime } = await loadAt('default');

    createCopilotRuntime(baseParams() as never);

    expect(fileText(logger)).toContain(SELECTION_MARKER);
    expect(console_?.text()).not.toContain(SELECTION_MARKER);
  });

  it('records a native session error in the log file and never on the console', async () => {
    const { logger, createCopilotSdkBackend } = await loadAt('default');

    await emitNativeError(createCopilotSdkBackend, 'upstream refused the turn');

    expect(fileText(logger)).toContain(NATIVE_MARKER);
    expect(console_?.text()).not.toContain(NATIVE_MARKER);
  });

  it('keeps both diagnostics off the console at debug level too', async () => {
    const { logger, createCopilotRuntime, createCopilotSdkBackend } = await loadAt('debug');

    createCopilotRuntime(baseParams() as never);
    await emitNativeError(createCopilotSdkBackend, 'upstream refused the turn');

    const file = fileText(logger);
    expect(file).toContain(SELECTION_MARKER);
    expect(file).toContain(NATIVE_MARKER);
    expect(console_?.text()).not.toContain(SELECTION_MARKER);
    expect(console_?.text()).not.toContain(NATIVE_MARKER);
  });

  it('emits nothing at all when the operator asked for silent', async () => {
    const { logger, createCopilotRuntime, createCopilotSdkBackend } = await loadAt('silent');

    createCopilotRuntime(baseParams() as never);
    await emitNativeError(createCopilotSdkBackend, 'upstream refused the turn');

    const file = fileText(logger);
    expect(file).not.toContain(SELECTION_MARKER);
    expect(file).not.toContain(NATIVE_MARKER);
    expect(console_?.text()).not.toContain(SELECTION_MARKER);
    expect(console_?.text()).not.toContain(NATIVE_MARKER);
  });

  it('never writes a hostile native payload to any sink', async () => {
    const { logger, createCopilotSdkBackend } = await loadAt('debug');

    await emitNativeError(createCopilotSdkBackend, HOSTILE_NATIVE_MESSAGE, HOSTILE_CODE);

    const file = fileText(logger);
    const consoleText = console_?.text() ?? '';

    // The failure is still reported ...
    expect(file).toContain(NATIVE_MARKER);
    // ... but neither credential shape reaches a sink, in `message` or `code` ...
    expect(file).not.toContain(HOSTILE_TOKEN);
    expect(file).not.toContain(HOSTILE_CODE);
    expect(consoleText).not.toContain(HOSTILE_TOKEN);
    expect(consoleText).not.toContain(HOSTILE_CODE);
    // ... and no C0, DEL or C1 control sequence survives into a file an
    // operator will `cat`. U+009B is the 8-bit CSI introducer.
    expect(file).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
  });
});
