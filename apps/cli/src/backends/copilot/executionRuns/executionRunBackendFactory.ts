import { createCopilotBackend } from '@/backends/copilot/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { readSpawnConfigOptionOverrideValue } from '@happier-dev/protocol';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import { SessionControlApplyError } from '@/agent/runtime/sessionControlApplyError';

const ordinaryFactory = createSimpleExecutionRunBackendFactory(createCopilotBackend);

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  const nativeAgent = readSpawnConfigOptionOverrideValue(opts.sessionConfigOptionOverrides, 'agent');
  if (nativeAgent === undefined || nativeAgent === null) {
    if (opts.start?.profileId && opts.start.intent !== 'voice_agent') {
      throw new Error('Copilot worker profile requires the native agent config option');
    }
    return ordinaryFactory(opts);
  }
  const backend = createCopilotBackend({
    cwd: opts.cwd, env: opts.isolation?.env, permissionHandler: opts.permissionHandler,
    permissionMode: permissionModeForExecutionRunPolicy(opts.permissionMode),
  });
  if (!(backend instanceof AcpBackend)) throw new Error('Copilot native selection requires ACP session controls');
  return withCopilotNativeSelection(backend, { ...opts, nativeAgent });
};

export function withCopilotNativeSelection(
  backend: AcpBackend,
  opts: Pick<Parameters<ExecutionRunBackendFactory>[0], 'modelId' | 'sessionConfigOptionOverrides'> & {
    nativeAgent: string | number | boolean;
  },
): AcpBackend {
  const nativeAgent = opts.nativeAgent;
  const handlers = new Set<AgentMessageHandler>();
  const register = backend.onMessage.bind(backend);
  backend.onMessage = (handler) => { handlers.add(handler); register(handler); };
  const apply = async (sessionId: SessionId) => {
    const initialOptions = backend.getSessionConfigOptionsState() ?? [];
    const agentOption = initialOptions.find((option) => option.id === 'agent');
    if (!agentOption) {
      throw SessionControlApplyError.definitive(new Error('Copilot did not expose native-agent selection; verify runtime, authentication and workspace setup'));
    }
    if (!agentOption?.options?.some((option) => option.value === nativeAgent)) {
      throw SessionControlApplyError.definitive(new Error(`Native Copilot agent "${nativeAgent}" is unavailable in this workspace`));
    }
    for (const id of Object.keys(opts.sessionConfigOptionOverrides?.overrides ?? {})) {
      const option = initialOptions.find((entry) => entry.id === id);
      if (!option) throw SessionControlApplyError.definitive(new Error(`Copilot did not expose config option "${id}"`));
      if (option.category === 'permissions' || option.category === 'mode' || id === 'allow_all' || id === 'mode') {
        throw SessionControlApplyError.definitive(new Error('Worker config options cannot override permission policy or execution mode'));
      }
    }
    await backend.setSessionConfigOption(sessionId, 'agent', nativeAgent, { requireAcknowledgement: true });
    // Selecting an agent can change the model. Apply the explicit model afterwards.
    if (opts.modelId) {
      const modelOption = backend.getSessionConfigOptionsState()?.find((option) => option.category === 'model' || option.id === 'model');
      if (!modelOption) throw SessionControlApplyError.definitive(new Error('Copilot cannot acknowledge the required model selection'));
      await backend.setSessionConfigOption(sessionId, modelOption.id, opts.modelId, { requireAcknowledgement: true });
    }
    for (const id of Object.keys(opts.sessionConfigOptionOverrides?.overrides ?? {})) {
      if (id === 'agent') continue;
      const value = readSpawnConfigOptionOverrideValue(opts.sessionConfigOptionOverrides, id);
      if (value !== undefined && value !== null) {
        await backend.setSessionConfigOption(sessionId, id, value, { requireAcknowledgement: true });
      }
    }
    const state = backend.getSessionConfigOptionsState();
    const effectiveAgent = state?.find((option) => option.id === 'agent')?.currentValue;
    const effectiveModel = state?.find((option) => option.category === 'model' || option.id === 'model')?.currentValue;
    if (effectiveAgent !== nativeAgent || (opts.modelId && effectiveModel !== opts.modelId)) {
      throw SessionControlApplyError.definitive(new Error('Copilot effective agent/model does not match requested selection'));
    }
    for (const handler of handlers) handler({
      type: 'event', name: 'execution_run_native_selection', payload: {
        agentId: effectiveAgent,
        ...(typeof effectiveModel === 'string' ? { modelId: effectiveModel } : {}),
        verification: 'provider_acknowledged',
      },
    });
  }
  const start = backend.startSession.bind(backend);
  backend.startSession = async (prompt) => {
    if (prompt) throw new Error('Native selection must complete before the first assignment');
    const result = await start();
    await apply(result.sessionId);
    return result;
  };
  const load = backend.loadSession.bind(backend);
  backend.loadSession = async (id) => {
    const result = await load(id);
    await apply(result.sessionId);
    return result;
  };
  const replay = backend.loadSessionWithReplayCapture.bind(backend);
  backend.loadSessionWithReplayCapture = async (id) => {
    const result = await replay(id);
    await apply(result.sessionId);
    return result;
  };
  return backend;
}
