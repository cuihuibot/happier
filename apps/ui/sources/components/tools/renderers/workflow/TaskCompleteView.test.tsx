import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

// `MarkdownView` is the shared markdown rendering boundary; the contract under test is which
// text this card hands to it.
vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: { markdown: string }) => React.createElement('MarkdownView', props),
}));

const LONG_SUMMARY = [
    '## What changed',
    '',
    '- Restored the stored completion summary inside the hosted tool card.',
    '- Kept the collapsed timeline density untouched for every other tool row.',
    '',
    'This body is deliberately longer than the previous 140 character key/value preview budget so a truncated render fails.',
].join('\n');

async function renderTaskCompleteView(props: Parameters<typeof makeToolViewProps>[1], tool = makeToolCall({
    name: 'task_complete',
    state: 'completed',
    input: { summary: LONG_SUMMARY },
    result: {},
})) {
    const { TaskCompleteView } = await import('./TaskCompleteView');
    return renderScreen(React.createElement(TaskCompleteView, makeToolViewProps(tool, props)));
}

function readMarkdown(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen
        .findAllByType('MarkdownView' as any)
        .map((node: any) => String(node.props.markdown));
}

describe('TaskCompleteView', () => {
    it.each(['summary', 'full'] as const)('renders the whole stored summary at detailLevel=%s', async (detailLevel) => {
        const screen = await renderTaskCompleteView({ detailLevel });

        const markdown = readMarkdown(screen);
        expect(markdown).toHaveLength(1);
        expect(markdown[0]).toBe(LONG_SUMMARY);
    });

    it('renders nothing at detailLevel=title', async () => {
        const screen = await renderTaskCompleteView({ detailLevel: 'title' });

        expect(readMarkdown(screen)).toHaveLength(0);
    });

    it('falls back to a completion summary stored on the tool result', async () => {
        const screen = await renderTaskCompleteView(
            { detailLevel: 'summary' },
            makeToolCall({
                name: 'task_complete',
                state: 'completed',
                input: {},
                result: { summary: LONG_SUMMARY },
            }),
        );

        expect(readMarkdown(screen)).toEqual([LONG_SUMMARY]);
    });

    it.each([
        ['missing', {}],
        ['blank', { summary: '   ' }],
        ['non-string', { summary: { text: 'nope' } }],
    ])('renders no invented content when the summary is %s', async (_label, input) => {
        const screen = await renderTaskCompleteView(
            { detailLevel: 'full' },
            makeToolCall({ name: 'task_complete', state: 'completed', input, result: {} }),
        );

        expect(readMarkdown(screen)).toHaveLength(0);
    });
});
