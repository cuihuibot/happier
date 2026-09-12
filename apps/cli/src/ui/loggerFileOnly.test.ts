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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('logger file-only siblings', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-cli-logger-file-only-');
        envScope.patch({
            HAPPIER_HOME_DIR: tempDir,
            DEBUG: undefined,
            HAPPIER_LOG_LEVEL: undefined,
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
});
