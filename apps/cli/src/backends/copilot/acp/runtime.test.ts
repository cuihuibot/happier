import { describe, expect, it } from 'vitest';

import type { AgentState } from '@/api/types';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCopilotAcpRuntime } from './runtime';

describe('Copilot ACP regular-session steering', () => {
  it('keeps the accepted ACP steering path enabled and available only during an active turn', async () => {
    let agentState: AgentState = { requests: {}, completedRequests: {} };
    const session = createApiSessionClientFixture();
    session.updateAgentState = async (update) => {
      agentState = update(agentState);
    };
    const runtime = createCopilotAcpRuntime({
      directory: '/tmp',
      machineId: 'steering-test-machine',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      providerInputConsumer: {
        waitForNextInput: async () => null,
        runProviderInputDispatch: async <Value>({ dispatch }: { dispatch: () => Promise<Value> }) => ({
          status: 'dispatched' as const,
          value: await dispatch(),
        }),
        closeProviderInputAdmissionAndWaitForDispatches: async () => {},
        drainPending: async () => ({ materialized: 0, stoppedReason: 'no_pending' as const }),
        pumpPendingWhileActive: async () => {},
      },
    });

    try {
      expect(runtime.supportsInFlightSteer()).toBe(true);
      expect(agentState.capabilities).toMatchObject({
        inFlightSteerSupported: true,
        inFlightSteerAvailable: false,
      });

      runtime.beginTurn();
      expect(runtime.isTurnInFlight()).toBe(true);
      expect(agentState.capabilities).toMatchObject({
        inFlightSteerSupported: true,
        inFlightSteerAvailable: true,
      });

      await runtime.flushTurn();
      expect(runtime.isTurnInFlight()).toBe(false);
      expect(agentState.capabilities).toMatchObject({
        inFlightSteerSupported: true,
        inFlightSteerAvailable: false,
      });
    } finally {
      await runtime.reset();
    }
  });
});
