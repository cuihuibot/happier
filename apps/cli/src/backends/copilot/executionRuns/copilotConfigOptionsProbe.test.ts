import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { probeAgentConfigOptionsBestEffort } from '@/capabilities/probes/agentConfigOptionsProbe';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('Copilot contextual config options discovery', () => {
  it.each([true, false])('enumerates the actual workspace catalog (has native agents: %s) without inference', async (hasAgents) => {
    await withTempDir('h8-discovery-', async (dir) => {
      const callsPath = join(dir, 'calls.jsonl');
      const script = writeAcpTestAgentScript({
        dir, fileName: 'copilot-discovery.mjs', source: `
          import { appendFileSync } from 'node:fs';
          import { createInterface } from 'node:readline';
          createInterface({input:process.stdin}).on('line', line => {
            const req=JSON.parse(line);
            appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({method:req.method,cwd:req.params.cwd,pid:process.pid})+'\\n');
            let result={};
            if(req.method==='initialize') result={protocolVersion:1,authMethods:[]};
            if(req.method==='session/new') result={sessionId:'discovery',configOptions:${JSON.stringify(hasAgents ? [{
              id: 'agent', name: 'Agent', category: '_agent', type: 'select', currentValue: '',
              options: [{ value: '', name: 'Copilot' }, { value: 'reader', name: 'Reader' }],
            }] : [])}};
            if(req.method==='session/prompt') process.exit(42);
            if(req.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
          });
        `,
      });
      await chmod(script, 0o755);
      const result = await probeAgentConfigOptionsBestEffort({
        agentId: 'copilot', cwd: dir, timeoutMs: 5_000,
        processEnv: { ...process.env, HAPPIER_COPILOT_PATH: script },
      });
      expect(result).toMatchObject({ provider: 'copilot', source: 'dynamic' });
      expect(result.status).toBeUndefined();
      expect(result.configOptions).toEqual(hasAgents ? [expect.objectContaining({
        id: 'agent', currentValue: '', options: [{ value: '', name: 'Copilot' }, { value: 'reader', name: 'Reader' }],
      })] : []);
      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { method: string; cwd?: string; pid: number });
      expect(calls.filter((call) => call.method !== 'session/cancel').map((call) => call.method))
        .toEqual(['initialize', 'session/new']);
      expect(calls[1]?.cwd).toBe(dir);
      expect(() => process.kill(calls[0]!.pid, 0)).toThrow();
    });
  });

  it('classifies a timed-out provider as failed and terminates its process', async () => {
    await withTempDir('h8-discovery-timeout-', async (dir) => {
      const pidPath = join(dir, 'pid');
      const script = writeAcpTestAgentScript({
        dir, fileName: 'copilot-timeout.mjs', source: `
          import { writeFileSync } from 'node:fs';
          writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
          process.stdin.resume();
        `,
      });
      await chmod(script, 0o755);
      const result = await probeAgentConfigOptionsBestEffort({
        agentId: 'copilot', cwd: dir, timeoutMs: 500,
        processEnv: { ...process.env, HAPPIER_COPILOT_PATH: script },
      });
      expect(result).toMatchObject({ source: 'static', status: 'failed', configOptions: [] });
      const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });
});
