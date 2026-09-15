import { describe, it, expect } from 'vitest';
import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import { PERMISSION_RESPONSE_CLAIM_V1 } from './agentStateRequestStore';

/**
 * A permission request only justifies suspending a turn's liveness watchdog when it
 * is durably published into agent state *and* this runtime still owns the waiter that
 * a decision would resolve. Anything else is an invisible prompt: no client can answer
 * it, so waiting on it forever is silent indefinite thinking.
 */

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: unknown) => unknown>();
  registerHandler(name: string, handler: (payload: unknown) => unknown) {
    this.handlers.set(name, handler);
  }
}

class FakeSession {
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
}

class TestPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string {
    return '[Test]';
  }

  request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return this.requestPermissionDecision(toolCallId, toolName, input);
  }
}

describe('BasePermissionHandler pending-request actionability', () => {
  it('reports a published, runtime-owned request as actionable', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const pending = handler.request('perm-live', 'Bash', { command: ['bash', '-lc', 'ls'] });

    expect(session.agentState.requests['perm-live']).toBeDefined();
    expect(handler.isPendingRequestActionable('perm-live')).toBe(true);

    handler.reset();
    await expect(pending).rejects.toThrow();
  });

  it('reports an unknown or never-published request as not actionable', () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    expect(handler.isPendingRequestActionable('perm-never-published')).toBe(false);
  });

  it('stops reporting a request as actionable once it is no longer published in agent state', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const pending = handler.request('perm-dropped', 'Bash', { command: ['bash', '-lc', 'ls'] });
    expect(handler.isPendingRequestActionable('perm-dropped')).toBe(true);

    // The durable publication disappeared (e.g. the agent-state write never survived).
    // The provider is still blocked, but no client can answer it any more.
    delete session.agentState.requests['perm-dropped'];
    expect(handler.isPendingRequestActionable('perm-dropped')).toBe(false);

    handler.reset();
    await expect(pending).rejects.toThrow();
  });

  it('reports a request claimed by a newer runtime as not actionable', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const pending = handler.request('perm-claimed', 'Bash', { command: ['bash', '-lc', 'ls'] });
    expect(handler.isPendingRequestActionable('perm-claimed')).toBe(true);

    session.agentState.requests['perm-claimed'] = {
      ...session.agentState.requests['perm-claimed'],
      [PERMISSION_RESPONSE_CLAIM_V1]: { runtimeId: 'newer-runtime' },
    };
    expect(handler.isPendingRequestActionable('perm-claimed')).toBe(false);

    handler.reset();
    await expect(pending).rejects.toThrow();
  });
});
