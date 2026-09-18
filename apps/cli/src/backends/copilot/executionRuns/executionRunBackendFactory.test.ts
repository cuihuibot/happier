import { describe, expect, it, vi } from 'vitest';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { executionRunBackendFactory, withCopilotNativeSelection } from './executionRunBackendFactory';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

function fixture(dir: string, stale = false) {
  return new AcpBackend({
    agentName: 'copilot-fixture', cwd: dir, command: process.execPath,
    args: [writeAcpTestAgentScript({
      dir, fileName: 'native-fixture.mjs', source: `
        import { createInterface } from 'node:readline';
        const options = [
          {id:'agent',name:'Agent',category:'_agent',type:'select',currentValue:'',options:[{value:'',name:'Copilot'},{value:'reader',name:'Reader'}]},
          {id:'model',name:'Model',category:'model',type:'select',currentValue:'initial',options:[{value:'chosen',name:'Chosen'}]},
          {id:'allow_all',name:'Permissions',category:'permissions',type:'select',currentValue:'off',options:[{value:'on',name:'On'}]}
        ];
        createInterface({input:process.stdin}).on('line', line => {
          const req=JSON.parse(line);
          let result={};
          if(req.method==='initialize') result={protocolVersion:1,authMethods:[]};
          if(req.method==='session/new') result={sessionId:'native-fixture',configOptions:options};
          if(req.method==='session/set_config_option') {
            if (!${JSON.stringify(stale)}) {
              options.find(o=>o.id===req.params.configId).currentValue=req.params.value;
              if(req.params.configId==='agent') options.find(o=>o.id==='model').currentValue='native-default';
            }
            result={configOptions:options};
          }
          if(req.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
        });
      `,
    })],
  });
}

describe('Copilot native selection over real ACP transport', () => {
  it('preserves the provider empty-string default identity and its selectable choice', async () => {
    await withTempDir('h8-default-identity-', async (dir) => {
      const backend = fixture(dir);
      try {
        const started = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()?.find((option) => option.id === 'agent')).toMatchObject({
          currentValue: '', options: [{ value: '', name: 'Copilot' }, { value: 'reader', name: 'Reader' }],
        });
        await backend.setSessionConfigOption(started.sessionId, 'agent', 'reader', { requireAcknowledgement: true });
        await backend.setSessionConfigOption(started.sessionId, 'agent', '', { requireAcknowledgement: true });
        expect(backend.getSessionConfigOptionsState()?.find((option) => option.id === 'agent')?.currentValue).toBe('');
      } finally { await backend.dispose(); }
    });
  });
  it('keeps voice-profile backend construction on its existing non-worker path', async () => {
    vi.stubEnv('HAPPIER_COPILOT_PATH', process.execPath);
    try {
      const backend = executionRunBackendFactory({
        backendId: 'copilot', cwd: process.cwd(), permissionMode: 'read_only',
        permissionHandler: createExecutionRunPermissionHandler({ backendId: 'copilot', permissionMode: 'read_only' }),
        start: { profileId: 'voice-profile', intent: 'voice_agent' },
      });
      expect(backend).toBeInstanceOf(AcpBackend);
      await backend.dispose();
    } finally { vi.unstubAllEnvs(); }
  });
  it('selects native identity before applying the explicit model and publishes only acknowledged values', async () => {
    await withTempDir('h8-selection-', async (dir) => {
      const backend = withCopilotNativeSelection(fixture(dir), { nativeAgent: 'reader', modelId: 'chosen' });
      const messages: AgentMessage[] = [];
      backend.onMessage((message) => messages.push(message));
      try {
        await backend.startSession();
        expect(messages).toContainEqual({
          type: 'event', name: 'execution_run_native_selection',
          payload: { agentId: 'reader', modelId: 'chosen', verification: 'provider_acknowledged' },
        });
      } finally { await backend.dispose(); }
    });
  });
  it('rejects stale native acknowledgment before any assignment', async () => {
    await withTempDir('h8-stale-', async (dir) => {
      const backend = withCopilotNativeSelection(fixture(dir, true), { nativeAgent: 'reader' });
      try { await expect(backend.startSession()).rejects.toThrow(/acknowledge/i); }
      finally { await backend.dispose(); }
    });
  });
  it('does not let a profile config option change provider permission policy', async () => {
    await withTempDir('h8-permission-', async (dir) => {
      const backend = withCopilotNativeSelection(fixture(dir), {
        nativeAgent: 'reader',
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { allow_all: { value: 'on', updatedAt: 1 } } },
      });
      try { await expect(backend.startSession()).rejects.toThrow(/permission|policy/i); }
      finally { await backend.dispose(); }
    });
  });
});
