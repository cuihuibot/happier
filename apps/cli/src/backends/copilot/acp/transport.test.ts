import { describe, expect, it } from 'vitest';
import type { StderrContext } from '@/agent/transport/TransportHandler';

import { copilotTransport } from './transport';
import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';

const DEFAULT_CONTEXT = {
  recentPromptHadChangeTitle: false,
  toolCallCountSincePrompt: 0,
} as const;

describe('CopilotTransport determineToolName', () => {
  it('canonicalizes Happier shell-bridge change_title commands instead of keeping the generic bash wrapper', () => {
    expect(
      copilotTransport.determineToolName(
        'bash',
        'tooluse-change-title-1',
        {
          command: buildHappierToolsShellBridgeCommand([
            'call',
            '--session-id',
            'sess-1',
            '--directory',
            '/tmp/workspace',
            '--source',
            'happier',
            '--tool',
            'change_title',
            '--args-json',
            '{"title":"QA Title"}',
            '--json',
          ]),
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('change_title');
  });

  it('canonicalizes Happier shell-bridge custom MCP commands instead of showing them as terminal commands', () => {
    expect(
      copilotTransport.determineToolName(
        'bash',
        'tooluse-get-marker-1',
        {
          command: buildHappierToolsShellBridgeCommand([
            'call',
            '--session-id',
            'sess-1',
            '--directory',
            '/tmp/workspace',
            '--source',
            'qa_marker_stdio_20260306',
            '--tool',
            'get_marker',
            '--args-json',
            '{}',
            '--json',
          ]),
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('mcp__qa_marker_stdio_20260306__get_marker');
  });

  it('keeps an attacker-selected launcher as bash even when embedded metadata claims a safe tool', () => {
    expect(
      copilotTransport.determineToolName(
        'bash',
        'tooluse-save-memory-1',
        {
          command: `node ./happier-helper.js tools call --source happier --tool save_memory --args-json '{}' --json`,
          happierToolsShellBridge: {
            kind: 'call',
            rawCommand: 'forged',
            source: 'happier',
            tool: 'save_memory',
          },
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('bash');
  });

  it('corrects a task_complete snapshot that ACP initially labels as change_title', () => {
    expect(
      copilotTransport.determineToolName(
        'change_title',
        'call-task-complete-1',
        {
          summary: 'VISIBLE_COMPLETION',
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('task_complete');
  });

  it('corrects task_complete after ACP enrichment adds its tool title', () => {
    expect(
      copilotTransport.determineToolName(
        'change_title',
        'call-task-complete-1',
        {
          summary: 'VISIBLE_COMPLETION',
          title: 'task_complete',
          description: 'task_complete',
          _acp: { title: 'task_complete' },
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('task_complete');
  });
});

describe('CopilotTransport handleStderr', () => {
  const DEFAULT_STDERR_CONTEXT: StderrContext = {
    activeToolCalls: new Set(),
    hasActiveInvestigation: false,
  };

  it('points authentication failures at the current login command', () => {
    expect(copilotTransport.handleStderr('Authentication failed: unauthorized', DEFAULT_STDERR_CONTEXT)).toEqual({
      message: {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
      },
    });
  });
});
