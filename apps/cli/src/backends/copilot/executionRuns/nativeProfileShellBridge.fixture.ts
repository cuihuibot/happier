import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { appendFile } from 'node:fs/promises';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountSettingsParse, redactBugReportSensitiveText } from '@happier-dev/protocol';
import { z } from 'zod';

import { ApiClient } from '@/api/api';
import { handleToolsCommand } from '@/cli/commands/tools';

// Only the remote Happier account/session boundary is substituted. The parent
// runs the real CLI parser over its shell and the real source MCP/action host.
const url = z.string().url().parse(process.env.H8_MCP_URL);
if (new URL(url).hostname !== '127.0.0.1') throw new Error('Fixture bridge must be loopback');
const settings = accountSettingsParse(JSON.parse(z.string().parse(process.env.H8_ACCOUNT_SETTINGS)));
const diagnosticsPath = z.string().min(1).parse(process.env.H8_DIAGNOSTICS_PATH);
const credentials = {
  token: 'isolated-in-process-only',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
};

if (process.argv[2] !== 'tools') throw new Error('Only the tools command is allowed');
await handleToolsCommand(process.argv.slice(3), {
  readCredentials: async () => credentials,
  initializeBackendApiContext: async () => ({ api: await ApiClient.create(credentials), machineId: 'fixture' }),
  bootstrapAccountSettingsContext: async () => ({
    settings, source: 'cache', settingsVersion: 1, loadedAtMs: Date.now(),
    settingsSecretsReadKeys: [], whenRefreshed: null,
  }),
  resolveCustomHappierToolsContext: async () => ({ mcpServers: {}, warnings: [] }),
  callBuiltInHappierTool: async ({ toolName, args }) => {
    const client = new Client({ name: 'h8-source-shell-fixture', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const reply = await client.callTool({
        name: toolName,
        arguments: z.record(z.string(), z.unknown()).parse(args),
      });
      const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(reply.content);
      const result: unknown = JSON.parse(content.map((item) => item.text).join(''));
      await appendFile(diagnosticsPath, redactBugReportSensitiveText(JSON.stringify({
        sourceMcpResult: { toolName, args, isError: reply.isError === true, result },
      })) + '\n', { mode: 0o600 });
      return reply.isError
        ? { ok: false, ...z.object({ errorCode: z.string(), error: z.string(), details: z.unknown().optional() }).parse(result) }
        : { ok: true, result };
    } finally {
      await client.close();
    }
  },
});
