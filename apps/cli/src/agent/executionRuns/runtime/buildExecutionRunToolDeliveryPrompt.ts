import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveExecutionRunBuiltInAgentId } from './backendTargets';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { buildHappierToolsPromptAppendix } from '@/agent/tools/happierTools/runtime/buildHappierToolsPromptAppendix';

export function buildExecutionRunToolDeliveryPrompt(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  sessionId: string;
  directory: string;
  prompt: string;
}>): string {
  const agentId = resolveExecutionRunBuiltInAgentId(params.backendTarget);
  if (!agentId || resolveAgentToolsDelivery(agentId) !== 'shell_bridge') return params.prompt;

  const guidance = buildHappierToolsPromptAppendix({
    sessionId: params.sessionId,
    directory: params.directory,
    sessionAgentBridge: true,
    sessionTitleUpdatesMode: 'disabled',
  });
  return `${guidance}\n\n${params.prompt}`;
}
