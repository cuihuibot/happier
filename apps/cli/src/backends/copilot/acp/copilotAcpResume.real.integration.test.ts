/**
 * Opt-in GitHub Copilot ACP resume tests against the real Copilot CLI.
 *
 * These exercise the live acceptance boundary for stop/resume: the real ACP
 * protocol plus Happier's close/reopen behavior. They consume real Copilot
 * quota, so they are enabled explicitly with:
 *
 *   HAPPIER_CLI_COPILOT_ACP_INTEGRATION=1
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createCopilotAcpRuntime } from '@/backends/copilot/acp/runtime';
import { createCopilotBackend } from '@/backends/copilot/acp/backend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

function isCopilotInstalled(): boolean {
  return spawnSync('copilot', ['--version'], { encoding: 'utf8' }).status === 0;
}

function shouldRunCopilotAcpIntegration(): boolean {
  return process.env.HAPPIER_CLI_COPILOT_ACP_INTEGRATION === '1' && isCopilotInstalled();
}

function vendorSessionEventLogPath(vendorSessionId: string): string {
  return join(homedir(), '.copilot', 'session-state', vendorSessionId, 'events.jsonl');
}

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'copilot-acp-resume-'));
  writeFileSync(join(cwd, 'sample.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  return cwd;
}

function readPublishedCopilotSessionId(session: ApiSessionClient): unknown {
  const snapshot = session.getMetadataSnapshot() as Readonly<Record<string, unknown>> | null;
  return snapshot?.copilotSessionId;
}

function createRuntimeForWorkspace(params: Readonly<{
  cwd: string;
  session: ApiSessionClient;
}>) {
  return createCopilotAcpRuntime({
    directory: params.cwd,
    machineId: 'copilot-acp-resume-machine',
    session: params.session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    getPermissionMode: () => 'yolo',
    providerInputConsumer: {
      waitForNextInput: async () => null,
      runProviderInputDispatch: async <TValue,>({ dispatch }: { dispatch: () => Promise<TValue> }) => ({
        status: 'dispatched' as const,
        value: await dispatch(),
      }),
      closeProviderInputAdmissionAndWaitForDispatches: async () => {},
      drainPending: async () => ({ materialized: 0, stoppedReason: 'no_pending' as const }),
      pumpPendingWhileActive: async () => {},
    },
  });
}

describe.skipIf(!shouldRunCopilotAcpIntegration())(
  'Copilot ACP resume (real CLI, opt-in)',
  { timeout: 600_000 },
  () => {
    it('rejects loading a vendor session that has not persisted a turn', async () => {
      const cwd = createWorkspace();
      const backend = createCopilotBackend({ cwd, permissionMode: 'yolo', mcpServers: {} });
      const { sessionId } = await backend.startSession();
      await backend.dispose();
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(existsSync(vendorSessionEventLogPath(sessionId))).toBe(false);

      const reopened = createCopilotBackend({ cwd, permissionMode: 'yolo', mcpServers: {} });
      const loadSession = reopened.loadSession;
      expect(loadSession).toBeTypeOf('function');
      await expect(loadSession!.call(reopened, sessionId)).rejects.toThrow(/not found/i);
      await reopened.dispose();
    });

    it('publishes the vendor resume id only once the vendor session can be resumed', async () => {
      const cwd = createWorkspace();
      const session = createMutableApiSessionClientFixture({ metadata: createTestMetadata() });
      const runtime = createRuntimeForWorkspace({ cwd, session });

      const vendorSessionId = await runtime.startOrLoad({});

      // The vendor session exists but Copilot cannot resume it yet, so Happier
      // must not record it as this session's resume target.
      expect(readPublishedCopilotSessionId(session)).toBeUndefined();

      runtime.beginTurn();
      await runtime.sendPrompt('Read sample.ts and reply only with the exported function name.');
      await runtime.flushTurn();

      expect(existsSync(vendorSessionEventLogPath(vendorSessionId))).toBe(true);
      expect(readPublishedCopilotSessionId(session)).toBe(vendorSessionId);

      await runtime.reset();
    });

    it('resumes the published vendor session after a close and reopen', async () => {
      const cwd = createWorkspace();
      const session = createMutableApiSessionClientFixture({ metadata: createTestMetadata() });

      const opened = createRuntimeForWorkspace({ cwd, session });
      await opened.startOrLoad({});
      opened.beginTurn();
      await opened.sendPrompt('Read sample.ts and reply only with the exported function name.');
      await opened.flushTurn();
      await opened.reset();
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const resumeId = readPublishedCopilotSessionId(session);
      expect(typeof resumeId).toBe('string');

      const reopened = createRuntimeForWorkspace({ cwd, session });
      await expect(
        reopened.startOrLoad({ resumeId: String(resumeId), importHistory: false }),
      ).resolves.toBe(resumeId);

      reopened.beginTurn();
      await reopened.sendPrompt('What function name did you just report? Reply with only the name.');
      await reopened.flushTurn();
      await reopened.reset();
    });
  },
);
