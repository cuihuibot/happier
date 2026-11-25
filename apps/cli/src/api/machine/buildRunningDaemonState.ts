import type { DaemonState } from '@/api/types';

export type ProcessOwnedDaemonState = Readonly<
  Pick<DaemonState, 'httpPort' | 'startedWithCliVersion' | 'daemonPendingSessionActivationSupported'>
>;

/**
 * Builds the daemonState published when machine control becomes ready. Fields describing the
 * running process come from that process: the server copy adopted at registration may belong to
 * an earlier daemon incarnation, and inheriting it would republish a stale identity forever.
 */
export function buildRunningDaemonState(params: Readonly<{
  previous: DaemonState | null;
  processOwned?: ProcessOwnedDaemonState;
  pid: number;
  now: number;
}>): DaemonState {
  const processOwnedFields = Object.fromEntries(
    Object.entries(params.processOwned ?? {}).filter(([, value]) => value !== undefined),
  ) as ProcessOwnedDaemonState;
  return {
    ...params.previous,
    ...processOwnedFields,
    status: 'running',
    pid: params.pid,
    startedAt: params.now,
  };
}
