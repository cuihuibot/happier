import { describe, expect, it } from 'vitest';

import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { extractHappierToolsShellBridgeToolNameHint } from './happierToolsShellBridgeToolNameHint';

describe('session-agent shell-bridge tool labeling', () => {
  it('retains the discovered managed source and tool while rejecting compound shell commands', () => {
    const command = buildHappierToolsShellBridgeCommand([
      'call',
      '--session-agent-bridge',
      '--session-id',
      'host-parent',
      '--directory',
      '/workspace/worker directory',
      '--source',
      'managed-source',
      '--tool',
      'lookup',
      '--args-json',
      '{}',
      '--json',
    ]);

    expect(extractHappierToolsShellBridgeToolNameHint({ command })).toBe('mcp__managed-source__lookup');
    expect(extractHappierToolsShellBridgeToolNameHint({ command: `${command} && echo extra` })).toBeNull();
  });
});
