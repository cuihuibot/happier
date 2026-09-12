/**
 * Sink-routing contract for the logger's file-only siblings.
 *
 * `info` and `warn` write to the console BEFORE consulting the file threshold,
 * so they disturb the provider terminal UI on every session and survive
 * `HAPPIER_LOG_LEVEL=silent`. Agent-session paths must therefore use `infoFile`
 * / `warnFile`, and this pins that they are genuinely file-only.
 *
 * These live outside `logger.test.ts` deliberately: that file already sits at a
 * heap cliff under its own repeated `resetModules()` + logger reconstruction
 * cycle, and appending even trivial re-import cases to it exhausts the worker.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('logger file-only siblings', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING', 'HAPPIER_SERVER_URL'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-cli-logger-file-only-');
        envScope.patch({
            HAPPIER_HOME_DIR: tempDir,
            DEBUG: undefined,
            HAPPIER_LOG_LEVEL: undefined,
            DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: undefined,
            HAPPIER_SERVER_URL: undefined,
        });
        vi.resetModules();
    });

    afterEach(() => {
        removeTempDirSync(tempDir);
        envScope.restore();
    });

    it('infoFile and warnFile write to the file but never to the console', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const captured = captureConsoleText();
        try {
            logger.infoFile('[TEST] info-file-line');
            logger.warnFile('[TEST] warn-file-line');
            logger.flushSync();

            const content = readFileSync(logger.getLogPath(), 'utf8');
            expect(content).toContain('[TEST] info-file-line');
            expect(content).toContain('[TEST] warn-file-line');
            expect(captured.text()).not.toContain('[TEST] info-file-line');
            expect(captured.text()).not.toContain('[TEST] warn-file-line');
        } finally {
            captured.restore();
        }
    });

    it('warnFile keeps warn severity so a warn-level operator still sees failures', async () => {
        process.env.HAPPIER_LOG_LEVEL = 'warn';
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.infoFile('[TEST] info-below-threshold');
        logger.warnFile('[TEST] warn-at-threshold');
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).not.toContain('[TEST] info-below-threshold');
        expect(content).toContain('[WARN] [TEST] warn-at-threshold');
    });

    it('suppresses both file-only siblings entirely at silent', async () => {
        process.env.HAPPIER_LOG_LEVEL = 'silent';
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const captured = captureConsoleText();
        try {
            logger.infoFile('[TEST] silent-info');
            logger.warnFile('[TEST] silent-warn');
            logger.flushSync();

            expect(existsSync(logger.getLogPath())).toBe(false);
            expect(captured.text()).not.toContain('[TEST] silent-info');
            expect(captured.text()).not.toContain('[TEST] silent-warn');
        } finally {
            captured.restore();
        }
    });

    // IQE-02: the remote forwarder inferred its level from the formatted text by
    // testing whether the prefix contained a timestamp. EVERY call site passes a
    // timestamp prefix, so every forwarded record claimed level 'debug' -- a
    // WARN was indistinguishable from a debug trace on the remote sink. Severity
    // is known at the call site and must be carried explicitly.
    it('forwards the real severity to the remote sink instead of guessing from the message text', async () => {
        const received: Array<{ level?: unknown; message?: unknown }> = [];
        const server = createServer((request, response) => {
            let body = '';
            request.setEncoding('utf8');
            request.on('data', (chunk: string) => {
                body += chunk;
            });
            request.on('end', () => {
                received.push(JSON.parse(body) as { level?: unknown; message?: unknown });
                response.writeHead(204);
                response.end();
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fixture did not bind');

        try {
            process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
            process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
            process.env.HAPPIER_LOG_LEVEL = 'debug';
            vi.resetModules();
            const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

            logger.warnFile('[TEST] remote-warn-severity');
            logger.infoFile('[TEST] remote-info-severity');
            logger.debug('[TEST] remote-debug-severity');
            logger.flushSync();

            for (let attempt = 0; attempt < 200 && received.length < 3; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            const levelOf = (marker: string) =>
                received.find((entry) => String(entry.message).includes(marker))?.level;

            expect(levelOf('[TEST] remote-warn-severity')).toBe('warn');
            expect(levelOf('[TEST] remote-info-severity')).toBe('info');
            expect(levelOf('[TEST] remote-debug-severity')).toBe('debug');
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
});
