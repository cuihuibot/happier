import { describe, expect, it, vi } from 'vitest';

/**
 * Seam guard for the experimental Copilot SDK runtime.
 *
 * The contract PA authorized is: a valid durable affinity wins outright, a
 * present-but-unreadable affinity is refused, and an unbound session may reach
 * the SDK only when the server authoritatively reported it as created AND the
 * experiment is explicitly opted into. These tests exercise the real selection
 * seam that `runCopilot` consumes -- not a mock of it.
 */
describe('copilot runtime seam', () => {
  const baseParams = () => ({
    directory: '/tmp/spike',
    machineId: 'machine-1',
    session: { getMetadataSnapshot: () => ({}) },
    messageBuffer: { addMessage: vi.fn() },
    mcpServers: [],
    permissionHandler: { handleToolCall: vi.fn() },
    onThinkingChange: vi.fn(),
    getPermissionMode: () => 'default',
    processEnv: {} as NodeJS.ProcessEnv,
  });

  // S2-Q-07: a lax prefix parse would silently install a different threshold
  // than the operator configured, and a fractional value would truncate the
  // guard toward zero. The seam must refuse rather than guess.
  it('rejects a malformed credit threshold instead of prefix-parsing it', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    const build = (raw: string) =>
      createCopilotRuntime({
        ...baseParams(),
        sessionLaunchOrigin: 'created',
        processEnv: {
          HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
          HAPPIER_COPILOT_SDK_CLI_PATH: '/usr/local/bin/copilot',
          HAPPIER_COPILOT_SDK_MAX_CREDITS: raw,
        } as NodeJS.ProcessEnv,
      } as never);

    expect(() => build('30abc')).toThrow(/credit/i);
    expect(() => build('0')).toThrow(/credit/i);
    expect(() => build('1.5')).toThrow(/credit/i);
    expect(() => build('-3')).toThrow(/credit/i);
  });

  it('builds the ACP runtime when the experiment flag is absent', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    const runtime = createCopilotRuntime({ ...baseParams() } as never);

    expect(runtime.runtimeKind).toBe('acp');
  });

  it('builds the SDK runtime for a new session under an explicit opt-in', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    const runtime = createCopilotRuntime({
      ...baseParams(),
      sessionLaunchOrigin: 'created',
      processEnv: {
        HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
        HAPPIER_COPILOT_SDK_CLI_PATH: '/usr/local/bin/copilot',
      } as NodeJS.ProcessEnv,
    } as never);

    expect(runtime.runtimeKind).toBe('sdk');
  });

  it('refuses to start the SDK runtime without an explicitly bound CLI path', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    // The spike must never let the SDK download or select its own bundled
    // runtime; an unbound path is a loud failure, not a fallback.
    expect(() =>
      createCopilotRuntime({
        ...baseParams(),
        sessionLaunchOrigin: 'created',
        processEnv: { HAPPIER_COPILOT_SDK_EXPERIMENT: '1' } as NodeJS.ProcessEnv,
      } as never),
    ).toThrow(/HAPPIER_COPILOT_SDK_CLI_PATH/);
  });

  it('keeps an unbound existing session on ACP even when the experiment is enabled', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    // `copilotSessionId` identifies the VENDOR session, never its transport, so
    // it neither opts a session in nor conflicts with a recorded affinity. The
    // authoritative origin is what withholds the SDK here.
    const runtime = createCopilotRuntime({
      ...baseParams(),
      session: { getMetadataSnapshot: () => ({ copilotSessionId: 'vendor-session-1' }) },
      sessionLaunchOrigin: 'existing',
      processEnv: {
        HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
        HAPPIER_COPILOT_SDK_CLI_PATH: '/usr/local/bin/copilot',
      } as NodeJS.ProcessEnv,
    } as never);

    expect(runtime.runtimeKind).toBe('acp');
  });

  it('withholds the SDK when the origin is unknown even under an explicit opt-in', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    // An older server omits the discriminator. Opting in must not be reported
    // as an SDK run.
    const runtime = createCopilotRuntime({
      ...baseParams(),
      sessionLaunchOrigin: 'unknown',
      processEnv: {
        HAPPIER_COPILOT_SDK_EXPERIMENT: '1',
        HAPPIER_COPILOT_SDK_CLI_PATH: '/usr/local/bin/copilot',
      } as NodeJS.ProcessEnv,
    } as never);

    expect(runtime.runtimeKind).toBe('acp');
  });

  it('reopens a durably SDK-bound session even when the experiment flag is off', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    const runtime = createCopilotRuntime({
      ...baseParams(),
      session: {
        getMetadataSnapshot: () => ({
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'copilot',
            provider: { backendMode: 'sdk', vendorSessionId: 'vendor-1' },
          },
        }),
      },
      sessionLaunchOrigin: 'existing',
      processEnv: {
        HAPPIER_COPILOT_SDK_CLI_PATH: '/usr/local/bin/copilot',
      } as NodeJS.ProcessEnv,
    } as never);

    expect(runtime.runtimeKind).toBe('sdk');
  });

  it('refuses to launch when the persisted backend identity is unreadable', async () => {
    const { createCopilotRuntime } = await import('./runtimeFactory');

    // Collapsing this to "absent" would start a bound session on the wrong
    // transport; refusing is the only safe outcome.
    expect(() =>
      createCopilotRuntime({
        ...baseParams(),
        session: {
          getMetadataSnapshot: () => ({
            agentRuntimeDescriptorV1: {
              v: 1,
              providerId: 'copilot',
              provider: { backendMode: 'grpc' },
            },
          }),
        },
        sessionLaunchOrigin: 'existing',
        processEnv: {} as NodeJS.ProcessEnv,
      } as never),
    ).toThrow(/unreadable persisted backend transport/i);
  });
});
