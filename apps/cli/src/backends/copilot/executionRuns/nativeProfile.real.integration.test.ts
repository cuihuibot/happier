import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import { createExecutionRunBackend } from '@/agent/executionRuns/runtime/createExecutionRunBackend';
import { accountSettingsParse, AIBackendProfileSchema, DelegateOutputV1Schema, ExecutionRunStartRequestSchema, resolveExecutionRunProfile, redactBugReportSensitiveText } from '@happier-dev/protocol';
import ts from 'typescript';
import { z } from 'zod';
import { probeAgentConfigOptionsBestEffort } from '@/capabilities/probes/agentConfigOptionsProbe';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { buildCopilotAcpBackendOptions } from '@/backends/copilot/acp/backend';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { PermissionMode } from '@/api/types';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { buildHappierToolsShellBridgeCommand, parseTrustedHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { resolveTsxImportHookSpecifier, resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';
import { extractShellCommand } from '@/agent/permissions/permissionToolIdentifier';

function logPublicDiagnostic(label: string, value: unknown) {
  console.info(redactBugReportSensitiveText(JSON.stringify({ [label]: value })));
}

async function readNativeEvents(vendorHome: string, sessionId: string, includeDescendants = false) {
  return (await readFile(join(vendorHome, 'session-state', sessionId, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => z.object({
      type: z.string(), agentId: z.string().nullish(), data: z.record(z.string(), z.unknown()),
    }).parse(JSON.parse(line)))
    // Copilot scopes descendant public messages separately from the parent.
    .filter((event) => includeDescendants || ![event.agentId, event.data.agentId, event.data.parentToolCallId]
      .some((value) => typeof value === 'string' && value.length > 0));
}

async function readNativePublicTurn(vendorHome: string, sessionId: string, turn: number): Promise<string> {
  const rows = await readNativeEvents(vendorHome, sessionId);
  let currentTurn = 0;
  const messages: string[] = [];
  for (const row of rows) {
    if (row.type === 'user.message') currentTurn++;
    if (currentTurn === turn && row.type === 'assistant.message' && typeof row.data.content === 'string' && row.data.content) {
      messages.push(row.data.content);
    }
  }
  if (messages.length === 0) throw new Error('No native public assistant output for this turn');
  return messages.join('');
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-native-profile-live-'));
  const cwd = join(root, 'workspace');
  const vendorHome = join(root, 'copilot');
  const marker = `H8_${randomUUID().replaceAll('-', '')}`;
  try {
    await mkdir(cwd);
    await mkdir(join(vendorHome, 'agents'), { recursive: true });
    const parsed = ts.parseConfigFileTextToJson('config.json', await readFile(join(homedir(), '.copilot', 'config.json'), 'utf8'));
    if (parsed.error) throw new Error('Unable to parse existing account-reference configuration');
    const referenceSchema = z.object({
      host: z.string().regex(/^(https:\/\/)?([a-z0-9-]+\.)*(github\.com|ghe\.com)\/?$/i),
      login: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    }).strict();
    const configuration: unknown = parsed.config;
    const accountConfig = z.object({ lastLoggedInUser: referenceSchema, loggedInUsers: z.array(referenceSchema) }).safeParse(configuration);
    if (!accountConfig.success) throw new Error('Account references contain unexpected structure; refusing to copy');
    const reference = accountConfig.data.lastLoggedInUser;
    if (!accountConfig.data.loggedInUsers.some((entry) => entry.host === reference.host && entry.login === reference.login)) {
      throw new Error('Selected account reference is not in the existing logged-in account list');
    }
    await writeFile(join(vendorHome, 'config.json'), JSON.stringify({
      lastLoggedInUser: reference, loggedInUsers: [reference], trustedFolders: [cwd],
    }), { mode: 0o600 });
    await writeFile(join(vendorHome, 'agents', 'h8-reader.agent.md'),
      '---\nname: h8-reader\ndescription: Isolated read-only acceptance worker\ntools: ["read"]\n---\nRead the assignment. Reply exactly as requested. Do not delegate or modify files.\n');
    await writeFile(join(vendorHome, 'agents', 'h8-checker.agent.md'),
      '---\nname: h8-checker\ndescription: Independent isolated arithmetic worker\ntools: ["read"]\n---\nRead the assignment. Reply exactly as requested. Do not delegate or modify files.\n');
    await writeFile(join(cwd, 'sample.txt'), `${marker}\n13 29\n`);
    await writeFile(join(cwd, 'checker.txt'), `${marker}_checker\n7 11\n`);
    return { root, cwd, vendorHome, marker };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// Existing provider/account only; all provider state and authored input are disposable.
describe.skipIf(process.env.HAPPIER_NATIVE_PROFILE_LIVE !== '1')('native profile managed Copilot (live)', () => {
  it('discovers native choices with isolated existing-account reference metadata', async () => {
    const fixture = await createFixture();
    try {
      const result = await probeAgentConfigOptionsBestEffort({
        agentId: 'copilot', cwd: fixture.cwd, timeoutMs: 30_000,
        processEnv: { ...process.env, COPILOT_HOME: fixture.vendorHome },
      });
      expect(result.source).toBe('dynamic');
      expect(result.status).toBeUndefined();
      const options = result.configOptions;
      console.info(JSON.stringify({
        marker: fixture.marker, source: import.meta.url,
        discoverySource: result.source,
        optionIds: options.map((option) => option.id),
        nativeChoices: options.find((option) => option.id === 'agent')?.options?.map((option) => option.value),
        modelCount: options.find((option) => option.id === 'model')?.options?.length ?? 0,
      }));
      expect(options.find((option) => option.id === 'agent')?.options?.some((option) => option.value === 'h8-reader')).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('completes a resumed bounded profile run with fresh results and the same native session', async () => {
    const { root, cwd, vendorHome, marker } = await createFixture();
    const profile = AIBackendProfileSchema.parse({
      id: 'bounded-reader', name: 'Bounded acceptance reader',
      executionRunDefaults: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'h8-reader', updatedAt: 1 } } },
        runClass: 'bounded', retentionPolicy: 'resumable', ioMode: 'request_response',
      },
    });
    const manager = new ExecutionRunManager({
      cwd, parentProvider: 'copilot', sendAcp: () => {},
      resolveAccountSettings: () => ({ profiles: [profile] }),
      createBackend: (options) => createExecutionRunBackend({
        ...options, cwd, accountSettings: {},
        connectedServicesEnv: { COPILOT_HOME: vendorHome },
      }),
    });
    let runId: string | undefined;
    try {
      const input = ExecutionRunStartRequestSchema.parse(resolveExecutionRunProfile({
        profileId: profile.id, intent: 'delegate', permissionMode: 'read_only', modelId: 'gpt-6-astra',
        instructions: `Do not use tools. Remember token ${marker} and number 37. Return exactly {"summary":"${marker}:37","deliverables":[]}.`,
      }, [profile], false));
      const started = await manager.start({ ...input, sessionId: `parent-${marker}` });
      runId = started.runId;
      await manager.waitForTerminal(runId);
      expect(manager.getPublic(runId)?.status).toBe('succeeded');
      expect(manager.getLatestToolResult(runId)).toMatchObject({ summary: `${marker}:37` });
      expect(manager.getPublic(runId)?.nativeSelection).toMatchObject({
        agentId: 'h8-reader', modelId: 'gpt-6-astra', verification: 'provider_acknowledged',
      });
      const resumeHandle = manager.getPublic(runId)?.resumeHandle;
      expect(resumeHandle?.kind).toBe('vendor_session.v1');

      expect(await manager.send(runId, {
        resume: true,
        message: 'Without tools, recall the token and number. Return JSON with summary equal to the token, a colon, and the number plus one; deliverables: [].',
      })).toMatchObject({ ok: true });
      expect(manager.getLatestToolResult(runId)).toBeNull();
      await manager.waitForTerminal(runId);
      expect(manager.getPublic(runId)?.status).toBe('succeeded');
      expect(manager.getLatestToolResult(runId)).toMatchObject({ summary: `${marker}:38` });
      expect(manager.getPublic(runId)?.resumeHandle).toEqual(resumeHandle);
      logPublicDiagnostic('boundedResume', {
        marker, status: manager.getPublic(runId)?.status,
        selection: manager.getPublic(runId)?.nativeSelection,
        sameNativeSession: true, source: import.meta.url,
      });
    } finally {
      if (runId) {
        await manager.stop(runId);
        await manager.waitForTerminal(runId);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);

  it('preserves two acknowledged native identities, explicit model and original-run recall through resume', async () => {
    const { root, cwd, vendorHome, marker } = await createFixture();
    const profiles = ['h8-reader', 'h8-checker'].map((agent) => AIBackendProfileSchema.parse({
      id: agent, name: `Acceptance ${agent}`,
      executionRunDefaults: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: agent, updatedAt: 1 } } },
        runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming',
      },
    }));
    const transcript: ACPMessageData[] = [];
    const manager = new ExecutionRunManager({
      cwd, parentProvider: 'copilot', sendAcp: (_provider, body) => { transcript.push(body); },
      resolveAccountSettings: () => ({ profiles }),
      createBackend: (options) => createExecutionRunBackend({
        ...options, cwd, accountSettings: {},
        connectedServicesEnv: { COPILOT_HOME: vendorHome },
      }),
    });
    const readSummary = (sidechainId: string, from: number) => {
      const messages = transcript.slice(from).filter((entry) => entry.type === 'message' && entry.sidechainId === sidechainId);
      const last = messages.at(-1);
      if (last?.type !== 'message') throw new Error('No completed sidechain response received');
      return DelegateOutputV1Schema.pick({ summary: true, deliverables: true })
        .parse(parseTrailingJsonObject(last.message)).summary;
    };
    const runIds: string[] = [];
    const vendorIds: string[] = [];
    try {
      for (const [index, profile] of profiles.entries()) {
      const expectedMarker = index === 0 ? marker : `${marker}_checker`;
      const file = index === 0 ? 'sample.txt' : 'checker.txt';
      const input = ExecutionRunStartRequestSchema.parse(resolveExecutionRunProfile({
        profileId: profile.name, intent: 'delegate', permissionMode: 'read_only', modelId: 'gpt-6-astra',
        instructions: `Read every line of ${file}. Return the required delegation JSON, with summary exactly equal to the first line and one deliverable describing the read.`,
      }, profiles, false));
      const started = await manager.start({ ...input, sessionId: `parent-${marker}` });
      runIds.push(started.runId);
      await vi.waitFor(() => {
        const run = manager.getPublic(started.runId);
        if (run?.error) throw new Error(`${run.error.code}: ${run.error.message}`);
        expect(run?.turnInFlight).toBe(false);
        expect(readSummary(started.sidechainId, 0)).toBe(expectedMarker);
      }, { timeout: 120_000, interval: 250 });
      expect(manager.getPublic(started.runId)?.nativeSelection).toMatchObject({
        agentId: profile.id, modelId: 'gpt-6-astra', verification: 'provider_acknowledged',
      });
      const vendorSession = manager.getPublic(started.runId)?.resumeHandle;
      expect(vendorSession?.kind).toBe('vendor_session.v1');
      if (vendorSession?.kind !== 'vendor_session.v1') throw new Error('Native resume handle required');
      vendorIds.push(vendorSession.vendorSessionId);
      const assertFidelity = async (turn: number, from: number) => {
        const responses = transcript.slice(from).filter((entry) =>
          entry.type === 'message' && entry.sidechainId === started.sidechainId);
        expect(responses).toHaveLength(1);
        const response = responses[0];
        if (response?.type !== 'message') throw new Error('Missing complete parent sidechain response');
        expect(response.message).toBe(await readNativePublicTurn(vendorHome, vendorSession.vendorSessionId, turn));
      };
      await assertFidelity(1, 0);
      const secondTurnStart = transcript.length;
      expect(await manager.send(started.runId, {
        message: 'Without rereading any file or using tools, recall the two numbers. Return the required delegation JSON with summary exactly equal to their sum and one deliverable describing the calculation.',
      })).toMatchObject({ ok: true });
      await vi.waitFor(() => {
        const run = manager.getPublic(started.runId);
        if (run?.error) throw new Error(`${run.error.code}: ${run.error.message}`);
        expect(manager.getPublic(started.runId)?.turnInFlight).toBe(false);
        expect(readSummary(started.sidechainId, secondTurnStart)).toBe(index === 0 ? '42' : '18');
      }, { timeout: 120_000, interval: 250 });
      expect(transcript.slice(secondTurnStart).filter((entry) => entry.type === 'tool-call')).toHaveLength(0);
      expect(manager.getPublic(started.runId)?.resumeHandle).toEqual(vendorSession);
      await assertFidelity(2, secondTurnStart);
      await manager.stop(started.runId);
      profile.executionRunDefaults!.sessionConfigOptionOverrides.overrides.agent = { value: 'edited-mapping-not-for-resume', updatedAt: 2 };
      const resumeStart = transcript.length;
      expect(await manager.send(started.runId, {
        resume: true,
        message: 'Without using any tools, recall the first line of the file you read. Return the required delegation JSON with that exact first line as summary and one deliverable describing the recall.',
      })).toMatchObject({ ok: true });
      await vi.waitFor(() => {
        const run = manager.getPublic(started.runId);
        if (run?.error) throw new Error(`${run.error.code}: ${run.error.message}`);
        expect(run?.turnInFlight).toBe(false);
        expect(readSummary(started.sidechainId, resumeStart)).toBe(expectedMarker);
      }, { timeout: 120_000, interval: 250 });
      expect(manager.getPublic(started.runId)?.resumeHandle).toEqual(vendorSession);
      expect(manager.getPublic(started.runId)?.nativeSelection).toMatchObject({
        agentId: profile.id, modelId: 'gpt-6-astra', verification: 'provider_acknowledged',
      });
      await assertFidelity(3, resumeStart);
      expect(transcript.slice(resumeStart).filter((entry) => entry.type === 'tool-call')).toHaveLength(0);
      console.info(JSON.stringify({ marker: expectedMarker, runId: started.runId, vendorSession,
        selection: manager.getPublic(started.runId)?.nativeSelection, turns: 3, resumed: true, source: import.meta.url }));
      }
      expect(new Set(runIds).size).toBe(2);
      expect(new Set(vendorIds).size).toBe(2);
    } finally {
      for (const runId of runIds) await manager.stop(runId);
      await rm(root, { recursive: true, force: true });
    }
  }, 540_000);

  it.each(['native', 'happier'] as const)('applies %s routing through a fresh source prompt loop and real provider tools', async (route) => {
    const fixture = await createFixture();
    const envScope = createEnvKeyScope([
      'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', 'HAPPIER_CLI_SUBPROCESS_ENTRYPOINT',
      'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
    ]);
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    const shellEntrypoint = join(fixture.root, 'happier-source-tools.mjs');
    const tsxHook = resolveTsxImportHookSpecifier();
    if (!tsxHook) throw new Error('Existing source loader required');
    await writeFile(shellEntrypoint, `import ${JSON.stringify(tsxHook)};\nawait import(${JSON.stringify(
      new URL('./nativeProfileShellBridge.fixture.ts', import.meta.url).href,
    )});\n`);
    process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = shellEntrypoint;
    process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '0';
    const profile = AIBackendProfileSchema.parse({
      id: 'h8-reader', name: 'Acceptance reader', defaultModelMode: 'gpt-6-astra',
      executionRunDefaults: {
        backendTarget: { kind: 'builtInAgent', agentId: 'copilot' },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { agent: { value: 'h8-reader', updatedAt: 1 } } },
      },
    });
    const settings = accountSettingsParse({
      profiles: [profile, AIBackendProfileSchema.parse({
        id: 'parent', name: 'Parent',
        codingPromptBehaviorV1: { v: 1, ...(route === 'native' ? { delegationRouting: 'native' } : {}) },
      })],
      codingPromptBehaviorV1: { v: 1, delegationRouting: 'happier', sessionTitleUpdates: 'disabled', responseOptions: 'disabled' },
    });
    const credentials = { token: 'isolated-in-process-only', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    setActiveAccountSettingsSnapshot({
      source: 'cache', settings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const outputs: ACPMessageData[] = [];
    const runs = new Map<string, ExecutionRunPublicState>();
    const session = createMutableApiSessionClientFixture({
      metadata: createTestMetadata({ path: fixture.cwd, profileId: 'parent', permissionMode: 'read-only', flavor: 'copilot' }),
      overrides: {
        sessionId: `fresh-${fixture.marker}`,
        sendAgentMessage: (_provider, body) => { outputs.push(body); },
      },
    });
    registerExecutionRunHandlers(session.rpcHandlerManager, {
      sessionId: session.sessionId, cwd: fixture.cwd, parentProvider: 'copilot',
      resolveAccountSettings: () => settings,
      sendAcp: (_provider, body) => { outputs.push(body); },
      onExecutionRunPublicStateUpdated: (run) => { runs.set(run.runId, run); },
      createBackend: (opts) => createExecutionRunBackend({
        ...opts, cwd: fixture.cwd,
        connectedServicesEnv: { ...opts.connectedServicesEnv, COPILOT_HOME: fixture.vendorHome },
      }),
    });
    const bridge = await createHappierMcpBridge({
      sessionId: session.sessionId, rpcHandlerManager: session.rpcHandlerManager,
      sendClaudeSessionMessage: () => {}, updateMetadata: (update) => session.updateMetadata(update),
      getMetadataSnapshot: () => session.getMetadataSnapshot(),
      getPermissionMode: () => 'read-only',
      getBackendTarget: () => ({ kind: 'builtInAgent', agentId: 'copilot' }),
    }, { credentials, accountSettings: settings });
    const bridgeCalls: string[] = [];
    const diagnosticsPath = join(fixture.root, 'public-bridge-diagnostics.jsonl');
    await writeFile(diagnosticsPath, '', { mode: 0o600 });
    const parentEnv = {
      COPILOT_HOME: fixture.vendorHome,
      H8_MCP_URL: bridge.happierMcpServer.url,
      H8_ACCOUNT_SETTINGS: JSON.stringify(settings),
      H8_DIAGNOSTICS_PATH: diagnosticsPath,
      TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
    };
    const parent = new AcpBackend(buildCopilotAcpBackendOptions({
      cwd: fixture.cwd, env: parentEnv, permissionMode: 'read-only', mcpServers: {},
      permissionHandler: {
        handleToolCall: async (_id, name, input) => {
          const command = extractShellCommand(input);
          const parsed = command ? parseTrustedHappierToolsShellBridgeCommand(command) : null;
          if (parsed?.sessionId === session.sessionId && parsed.directory === fixture.cwd
            && (parsed.kind === 'list' || (parsed.source === 'happier'
              && /^(?:execution_run_(?:start|get|list|send|wait)|action_(?:spec_get|options_resolve|execute))$/.test(parsed.tool)))) {
            bridgeCalls.push(parsed.kind === 'list' ? 'list' : parsed.tool);
            return { decision: 'approved' };
          }
          if (/bash|execute/i.test(name)) console.info(JSON.stringify({
            rejectedFixtureShell: {
              name, extracted: command !== null, trusted: parsed !== null,
              command: command?.includes('tools') ? command : '<not a tools command>',
            },
          }));
          return { decision: /^(?:read|task)$/i.test(name) ? 'approved' : 'denied' };
        },
      },
    }));
    const toolNames: string[] = [];
    let answer = '';
    parent.onMessage((message) => {
      if (message.type === 'tool-call') toolNames.push(message.toolName);
      if (message.type === 'model-output') answer = message.fullText ?? answer + (message.textDelta ?? '');
      if (message.type === 'tool-result') logPublicDiagnostic('parentToolResult', {
        callId: message.callId, toolName: message.toolName, isError: message.isError, result: message.result,
      });
      if (message.type === 'status') logPublicDiagnostic('parentStatus', message);
    });
    let parentId = '';
    let exit = false;
    const queue = new MessageQueue2<{ permissionMode: PermissionMode }, PermissionModeQueuedPrompt>(
      (mode) => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts },
    );
    const managedStartCommand = buildHappierToolsShellBridgeCommand([
      'call', '--session-id', session.sessionId, '--directory', fixture.cwd,
      '--source', 'happier', '--tool', 'action_execute', '--args-json', JSON.stringify({
        actionId: 'subagents.delegate.start',
        input: {
          profileId: 'h8-reader', permissionMode: 'read_only',
          runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response',
          instructions: 'Read sample.txt and return exactly its first line as your summary. Do not modify files.',
        },
      }), '--json',
    ]);
    queue.push({
      localId: null,
      text: [
        'Delegate reading sample.txt to one worker; do not read it yourself. The provider-native agent is h8-reader and its saved Happier worker profile ID is h8-reader. Follow the effective saved delegation route.',
        'If the saved route uses Happier, use this exact complete source CLI command, preserving the tools subcommand, session ID and directory. Do not substitute a PATH happier binary or list the full catalog:',
        managedStartCommand,
        'If the saved route is native, use the native task tool instead. Wait for the worker result, then return exactly the first line of that file. Do not modify files or launch extra workers.',
      ].join('\n'),
    }, { permissionMode: 'read-only' });
    let composedPrompt = '';
    try {
      expect(JSON.stringify(bridge.mcpServers.happier.args)).toContain('happyMcpStdioBridge.ts');
      expect(parseTrustedHappierToolsShellBridgeCommand(buildHappierToolsShellBridgeCommand([
        'list', '--session-id', session.sessionId, '--directory', fixture.cwd, '--json',
      ]))).toMatchObject({ kind: 'list', sessionId: session.sessionId, directory: fixture.cwd });
      expect(parseTrustedHappierToolsShellBridgeCommand(managedStartCommand))
        .toMatchObject({ kind: 'call', sessionId: session.sessionId, directory: fixture.cwd, tool: 'action_execute' });
      const listed = await promisify(execFile)(process.execPath, [
        shellEntrypoint, 'tools', 'list', '--session-id', session.sessionId,
        '--directory', fixture.cwd, '--json',
      ], { cwd: fixture.cwd, env: { ...process.env, ...parentEnv }, timeout: 30_000 });
      expect(JSON.parse(listed.stdout)).toMatchObject({
        ok: true, data: { sources: { happier: expect.arrayContaining([expect.objectContaining({ name: 'execution_run_start' })]) } },
      });
      await runPermissionModePromptLoop({
        providerName: 'Copilot', providerId: 'copilot', agentMessageType: 'copilot', explicitPermissionMode: 'read-only',
        session, messageQueue: queue,
        permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[h8-live]' }),
        runtime: {
          beginTurn: () => {},
          startOrLoad: async () => {
            parentId = (await parent.startSession()).sessionId;
            await parent.setSessionModel(parentId, 'gpt-6-astra');
          },
          sendPrompt: async (prompt) => {
            composedPrompt = prompt;
            await parent.sendPrompt(parentId, prompt);
            await parent.waitForResponseComplete(120_000);
          },
          flushTurn: () => {},
          reset: () => parent.dispose(),
          getSessionId: () => parentId || null,
        },
        createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
        messageBuffer: new MessageBuffer(), shouldExit: () => exit, getAbortSignal: () => new AbortController().signal,
        keepAlive: () => {}, setThinking: () => {}, sendReady: () => { exit = true; },
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode: () => {}, setCurrentPermissionModeUpdatedAt: () => {},
        resolveFreshSessionSystemPrompt: ({ baseOverride }) => resolveEffectiveCodingPromptText({
          credentials, settings, profileId: 'parent', baseOverride, providerId: 'copilot',
          executionRunsFeatureEnabled: true, memoryRecallGuidanceEnabled: false,
          toolDelivery: resolveAgentToolsDelivery('copilot'), toolDeliverySessionId: session.sessionId,
          toolDeliveryDirectory: fixture.cwd,
        }),
        formatPromptErrorMessage: (error) => {
          logPublicDiagnostic('promptLoopError', error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack } : String(error));
          return String(error);
        },
      });
      const nativeEvents = await readNativeEvents(fixture.vendorHome, parentId);
      const nativeToolNames = nativeEvents
        .filter((event) => event.type === 'tool.execution_start')
        .map((event) => event.data.toolName);
      console.info(JSON.stringify({ marker: fixture.marker, route, parentId, toolNames, nativeToolNames, bridgeCalls,
        managedRunIds: [...runs.keys()], answer, source: import.meta.url,
        shellSource: fileURLToPath(new URL('./nativeProfileShellBridge.fixture.ts', import.meta.url)),
        boundary: 'source prompt loop + source tools CLI + loopback source MCP; remote account/session fixture; real Copilot' }));
      expect(composedPrompt.split('# Happier-Managed Runs')).toHaveLength(2);
      expect(nativeToolNames.filter((name) => typeof name === 'string' && /read|view/i.test(name))).toHaveLength(0);
      if (route === 'native') {
        expect(nativeToolNames).toContain('task');
        expect(runs.size).toBe(0);
      } else {
        expect(runs.size).toBe(1);
        expect([...runs.values()][0]).toMatchObject({
          status: 'succeeded', turnInFlight: false,
          profileId: 'h8-reader', nativeSelection: { agentId: 'h8-reader', modelId: 'gpt-6-astra', verification: 'provider_acknowledged' },
        });
        expect(nativeToolNames).not.toContain('task');
      }
      const nativeAnswer = await readNativePublicTurn(
        fixture.vendorHome, parentId, nativeEvents.filter((event) => event.type === 'user.message').length,
      );
      expect(nativeAnswer.trim()).toBe(fixture.marker);
      if (route === 'happier') expect(answer).toBe(nativeAnswer);
    } finally {
      try {
        console.info(await readFile(diagnosticsPath, 'utf8'));
        logPublicDiagnostic('finalManagedStates', [...runs.values()].map((run) => ({
          runId: run.runId, status: run.status, turnInFlight: run.turnInFlight,
          error: run.error, summary: run.summary, nativeSelection: run.nativeSelection, resumeHandle: run.resumeHandle,
        })));
        logPublicDiagnostic('publicSidechainMessages', outputs.filter((output) => output.type === 'message'));
        if (parentId) {
          const events = await readNativeEvents(fixture.vendorHome, parentId, true);
          logPublicDiagnostic('nativePublicProvenance', events
            .filter((event) => ['assistant.message', 'tool.execution_start', 'tool.execution_complete', 'session.error'].includes(event.type))
            .map((event) => ({
              type: event.type, agentId: event.agentId ?? event.data.agentId,
              parentToolCallId: event.data.parentToolCallId, toolCallId: event.data.toolCallId,
              toolName: event.data.toolName,
              ...(event.type === 'tool.execution_complete' ? {
                success: event.data.success, result: event.data.result, error: event.data.error,
              } : {}),
              ...(event.type === 'assistant.message' ? { content: event.data.content } : {}),
              ...(event.type === 'session.error' ? { message: event.data.message, errorType: event.data.errorType } : {}),
            })));
        }
      } finally {
        await parent.dispose();
        for (const runId of runs.keys()) await session.rpcHandlerManager.invokeLocal('execution.run.stop', { runId });
        bridge.happierMcpServer.stop();
        resetActiveAccountSettingsSnapshotForTests();
        envScope.restore();
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }, 240_000);
});
