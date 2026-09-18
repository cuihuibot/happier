import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks();

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session settings (prompt personalization)', () => {
    it.each([undefined, 'native', 'happier'] as const)('preserves saved routing %s when editing title behavior', async (delegationRouting) => {
        sessionSettingsEntryState.settingsState.codingPromptBehaviorV1 = {
            v: 1,
            sessionTitleUpdates: 'ongoing',
            responseOptions: 'agent',
            ...(delegationRouting ? { delegationRouting } : {}),
        };

        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const groupTitles = screen.findAllByType('ItemGroup' as any).map((group) => group.props.title);
        expect(groupTitles).toContain('settingsSession.rootGroups.agentPersonalization.title');
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle')).toBeTruthy();

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const titleDropdown = dropdowns.find((node: any) =>
            node.props?.itemTrigger?.title === 'settingsSession.promptPersonalization.askAgentToRenameSessionsTitle');
        expect(titleDropdown).toBeTruthy();
        expect(titleDropdown?.props?.selectedId).toBe('ongoing');
        expect(titleDropdown?.props?.items?.map((item: any) => item.id)).toEqual(['disabled', 'initial', 'ongoing']);

        titleDropdown!.props.onSelect('initial');
        expect(sessionSettingsEntryState.settingsState.codingPromptBehaviorV1).toEqual({
            v: 1,
            sessionTitleUpdates: 'initial',
            responseOptions: 'agent',
            ...(delegationRouting ? { delegationRouting } : {}),
        });
    });
});
