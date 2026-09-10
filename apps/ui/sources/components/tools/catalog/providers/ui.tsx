import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT, ICON_TASK_COMPLETE } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { TaskCompleteInputV2Schema } from '@happier-dev/protocol';
import { resolveTaskCompleteSummaryLead } from '../../normalization/normalize/taskCompleteSummary';

export const providerUiTools = {
    'change_title': {
        title: t('tools.names.changeTitle'),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: z.object({
            title: z.string().optional().describe('New session title')
        }).partial().passthrough(),
        result: z.object({}).partial().passthrough()
    },
    'task_complete': {
        title: t('tools.names.taskComplete'),
        icon: ICON_TASK_COMPLETE,
        noStatus: true,
        input: TaskCompleteInputV2Schema,
        result: z.object({
            summary: z.string().optional(),
        }).partial().passthrough(),
        // Without this the header subtitle falls back to the raw ACP title (`task_complete`),
        // which just repeats the card title. The first summary line is the real content and is
        // also what the compact timeline density shows inline.
        extractSubtitle: ({ tool }) => resolveTaskCompleteSummaryLead(tool),
    },
    WorkspaceIndexingPermission: {
        title: t('tools.workspaceIndexingPermission.defaultTitle'),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: z.object({
            toolCall: z.object({
                title: z.string().optional(),
                toolCallId: z.string().optional(),
            }).partial().optional(),
            options: z.array(z.object({
                id: z.string().optional(),
                name: z.string().optional(),
                kind: z.string().optional(),
            }).partial()).optional(),
        }).partial().passthrough(),
        result: z.object({}).partial().passthrough(),
    },
} satisfies Record<string, KnownToolDefinition>;
