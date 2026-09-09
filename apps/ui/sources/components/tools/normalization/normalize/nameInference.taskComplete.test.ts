import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameForRendering } from './nameInference';

const LONG_SUMMARY = [
    '## Done',
    '',
    'Repaired the completion card so the stored summary is readable again.',
    'Second line of the summary that pushes the payload well past the old 140 character key/value preview budget.',
].join('\n');

describe('canonicalizeToolNameForRendering (task_complete)', () => {
    it.each(['task_complete', 'task-complete'])('keeps the canonical completion tool name %s', (toolName) => {
        expect(canonicalizeToolNameForRendering(toolName, { summary: LONG_SUMMARY })).toBe('task_complete');
    });

    it('repairs a historical row mislabeled as change_title by the ACP title', () => {
        const name = canonicalizeToolNameForRendering(
            'change_title',
            {
                summary: LONG_SUMMARY,
                _acp: { kind: 'other', title: 'task_complete' },
                _happier: { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'change_title', canonicalToolName: 'change_title' },
            },
            'task_complete',
        );
        expect(name).toBe('task_complete');
    });

    it('repairs a historical row whose only completion evidence is the humanized description', () => {
        expect(
            canonicalizeToolNameForRendering('Unknown tool', { summary: LONG_SUMMARY }, 'Task complete'),
        ).toBe('task_complete');
    });

    it('leaves a genuine change_title row alone', () => {
        const name = canonicalizeToolNameForRendering(
            'change_title',
            { title: 'Repair the completion card', _acp: { kind: 'other', title: 'change_title' } },
            'change_title',
        );
        expect(name).toBe('change_title');
    });

    it('does not reclassify a change_title row that merely carries a summary field', () => {
        const name = canonicalizeToolNameForRendering(
            'change_title',
            { title: 'Repair the completion card', summary: LONG_SUMMARY },
            'change_title',
        );
        expect(name).toBe('change_title');
    });

    it('does not reclassify an unrelated summary-bearing tool', () => {
        expect(canonicalizeToolNameForRendering('SubAgentRun', { summary: LONG_SUMMARY }, 'Run subagent')).toBe('SubAgentRun');
    });

    it('does not reclassify a completion-titled row without a stored summary', () => {
        const name = canonicalizeToolNameForRendering(
            'change_title',
            { title: 'Repair the completion card', summary: '   ', _acp: { title: 'task_complete' } },
            'task_complete',
        );
        expect(name).toBe('change_title');
    });

    it('keeps a genuine change_title that also carries contradictory completion metadata', () => {
        const name = canonicalizeToolNameForRendering(
            'change_title',
            {
                title: 'IQE_REAL_TITLE',
                summary: LONG_SUMMARY,
                _acp: { title: 'task_complete' },
                _happier: { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'change_title', canonicalToolName: 'change_title' },
            },
            'task_complete',
        );
        expect(name).toBe('change_title');
    });

    it('keeps an explicitly identified unrelated tool that carries contradictory completion metadata', () => {
        const name = canonicalizeToolNameForRendering(
            'Bash',
            {
                command: 'printf harmless',
                summary: LONG_SUMMARY,
                _acp: { title: 'task_complete' },
                _happier: { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'Bash', canonicalToolName: 'Bash' },
            },
            'task_complete',
        );
        expect(name).toBe('Bash');
    });

    it('repairs a generic unknown identity recorded with completion metadata', () => {
        const name = canonicalizeToolNameForRendering(
            'other',
            {
                summary: LONG_SUMMARY,
                _acp: { kind: 'other', title: 'task_complete' },
                _happier: { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'other', canonicalToolName: 'unknown' },
            },
            'task_complete',
        );
        expect(name).toBe('task_complete');
    });

    // A row that stores its own `title` is a change-title payload whatever that title contains.
    // The completion card cannot display it, so the historical correction must stand down on the
    // property being present — not on the property holding renderable text.
    describe('own input.title property', () => {
        const withOwnTitle = (title: unknown) => ({
            title,
            summary: LONG_SUMMARY,
            _acp: { title: 'task_complete' },
            _happier: { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'change_title', canonicalToolName: 'change_title' },
        });

        it.each([
            ['empty string', ''],
            ['whitespace only', '   '],
            ['number', 42],
            ['object', {}],
            ['null', null],
            ['explicit undefined', undefined],
        ])('keeps change_title when the row stores its own %s title', (_label, title) => {
            expect(canonicalizeToolNameForRendering('change_title', withOwnTitle(title), 'task_complete')).toBe('change_title');
        });

        it('still repairs a historical row that stores no own title at all', () => {
            const input = {
                summary: LONG_SUMMARY,
                _acp: { title: 'task_complete' },
                _happier: { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'change_title', canonicalToolName: 'change_title' },
            };
            expect(Object.prototype.hasOwnProperty.call(input, 'title')).toBe(false);
            expect(canonicalizeToolNameForRendering('change_title', input, 'task_complete')).toBe('task_complete');
        });

        it('ignores an inherited title so only the row\'s own payload stands down the correction', () => {
            const input = Object.create({ title: 'inherited, not this row\'s payload' }) as Record<string, unknown>;
            input.summary = LONG_SUMMARY;
            input._acp = { title: 'task_complete' };
            input._happier = { v: 2, protocol: 'acp', provider: 'copilot', rawToolName: 'change_title', canonicalToolName: 'change_title' };
            expect(Object.prototype.hasOwnProperty.call(input, 'title')).toBe(false);
            expect(canonicalizeToolNameForRendering('change_title', input, 'task_complete')).toBe('task_complete');
        });

        it('keeps the canonical completion tool name even when the row stores its own title', () => {
            expect(canonicalizeToolNameForRendering('task_complete', withOwnTitle(''), 'task_complete')).toBe('task_complete');
        });
    });
});
