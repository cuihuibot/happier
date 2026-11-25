import { describe, expect, it } from 'vitest';

import { buildRunningDaemonState } from './buildRunningDaemonState';

describe('buildRunningDaemonState', () => {
    it('publishes the running process identity instead of inheriting a stale server copy', () => {
        const next = buildRunningDaemonState({
            previous: {
                status: 'offline',
                pid: 111,
                httpPort: 4000,
                startedAt: 1,
                startedWithCliVersion: '0.2.12-cuihui-single-result-1951a4ce-v1',
            },
            processOwned: {
                httpPort: 5000,
                startedWithCliVersion: '0.2.21',
                daemonPendingSessionActivationSupported: true,
            },
            pid: 222,
            now: 99,
        });

        expect(next).toEqual({
            status: 'running',
            pid: 222,
            httpPort: 5000,
            startedAt: 99,
            startedWithCliVersion: '0.2.21',
            daemonPendingSessionActivationSupported: true,
        });
    });

    it('keeps previously published fields when the process did not supply its own', () => {
        expect(buildRunningDaemonState({
            previous: { status: 'offline', httpPort: 4000, startedWithCliVersion: '0.2.21' },
            pid: 222,
            now: 99,
        })).toEqual({
            status: 'running',
            pid: 222,
            httpPort: 4000,
            startedAt: 99,
            startedWithCliVersion: '0.2.21',
        });
    });
});
