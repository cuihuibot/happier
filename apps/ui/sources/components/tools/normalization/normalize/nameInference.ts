import { asRecord, firstNonEmptyString, hasNonEmptyRecord } from './_shared';
import { canonicalizeGenericSubAgentToolName, isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

function isLegacySlashChangeTitleName(name: string): boolean {
    const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return normalized === 'happier/change_title' || normalized === 'happy/change_title';
}

function isUiChangeTitleAlias(name: string): boolean {
    return isChangeTitleToolNameAlias(name) || isLegacySlashChangeTitleName(name);
}

const TASK_COMPLETE_TOOL_NAME = 'task_complete';

function isTaskCompleteToken(value: unknown): boolean {
    const raw = firstNonEmptyString(value);
    if (!raw) return false;
    return raw.toLowerCase().replace(/[\s_-]+/g, '_') === TASK_COMPLETE_TOOL_NAME;
}

/**
 * The identities a completion event was actually recorded under before the CLI learned the rule:
 * the change-title tool it was misread as, and the generic unknown fallbacks. Any other identity is
 * an explicit tool claim and is never replaced.
 */
function isRepairableCompletionIdentity(name: string): boolean {
    if (isUiChangeTitleAlias(name)) return true;
    const normalized = name.trim().toLowerCase();
    return normalized === 'other' || normalized === 'unknown' || normalized === 'unknown tool';
}

/**
 * Turn-completion rows must reach the completion card, not the change-title card.
 *
 * Providers that publish the final turn summary as an ACP tool call are only identified by the
 * ACP title/description, so sessions recorded before the CLI learned that rule persisted the row
 * under a `change_title`/unknown identity while still carrying the real `summary`. Repair those
 * rows here — the UI compatibility layer that already owns legacy tool identities.
 *
 * The correction is deliberately narrow. It only replaces the identities such a row could have
 * been recorded under, it never overrides an explicit canonical identity a producer already
 * resolved, and it never fires when the row stores its own `title` property. A stored `title` is a
 * change-title payload whatever it holds — `""`, whitespace, or a non-string are all values the
 * change-title schema and view already handle, and none of them make the row a completion event.
 */
function resolveTaskCompleteToolName(toolName: string, input: unknown, description?: string | null): string | null {
    if (isTaskCompleteToken(toolName)) return TASK_COMPLETE_TOOL_NAME;

    const inputObj = asRecord(input);
    if (!firstNonEmptyString(inputObj?.summary)) return null;
    if (inputObj && Object.prototype.hasOwnProperty.call(inputObj, 'title')) return null;

    const recordedCanonicalName =
        firstNonEmptyString(asRecord(inputObj?._happier)?.canonicalToolName) ??
        firstNonEmptyString(asRecord(inputObj?._happy)?.canonicalToolName);
    if (recordedCanonicalName && isTaskCompleteToken(recordedCanonicalName)) return TASK_COMPLETE_TOOL_NAME;
    if (!isRepairableCompletionIdentity(recordedCanonicalName ?? toolName)) return null;

    const acpTitle = asRecord(inputObj?._acp)?.title;
    if (isTaskCompleteToken(acpTitle) || isTaskCompleteToken(description)) return TASK_COMPLETE_TOOL_NAME;

    return null;
}

function extractContradictoryWrappedToolName(params: {
    toolName: string;
    input: unknown;
    description?: string | null;
}): string | null {
    if (!isUiChangeTitleAlias(params.toolName)) return null;

    const inputObj = asRecord(params.input);
    const permission = asRecord(inputObj?.permission);
    const directToolName = firstNonEmptyString(inputObj?.toolName);
    const permissionToolName = firstNonEmptyString(permission?.toolName);
    const describedToolName = (() => {
        const raw = firstNonEmptyString(params.description);
        if (!raw) return null;
        const match = raw.match(/^tool:\s*(.+)$/i);
        return match?.[1]?.trim() || null;
    })();

    const candidates = [directToolName, permissionToolName, describedToolName].filter((value): value is string => !!value);
    const contradictory = candidates.find((candidate) => !isUiChangeTitleAlias(candidate));
    return contradictory ?? null;
}

function canonicalizeToolNameNonV2(toolName: string, input: unknown, description?: string | null): string {
    // NOTE: This path covers:
    // - legacy sessions (pre V2 tool normalization)
    // - Claude local-control sessions (tool events produced from a transcript; no `_happier` metadata)

    const inputObj = asRecord(input);

    if (toolName === 'CodexPatch' || toolName === 'GeminiPatch') return 'Patch';
    if (toolName === 'CodexDiff' || toolName === 'GeminiDiff') return 'Diff';
    if (toolName === 'CodexReasoning' || toolName === 'GeminiReasoning' || toolName === 'think') return 'Reasoning';
    const genericSubAgentToolName = canonicalizeGenericSubAgentToolName(toolName);
    if (genericSubAgentToolName) return genericSubAgentToolName;
    if (toolName === 'exit_plan_mode') return 'ExitPlanMode';

    if (isUiChangeTitleAlias(toolName)) {
        const contradictoryWrappedToolName = extractContradictoryWrappedToolName({ toolName, input, description });
        if (contradictoryWrappedToolName) return 'unknown';
        return 'change_title';
    }

    const lower = toolName.toLowerCase();
    if (lower === 'patch') return 'Patch';
    if (lower === 'diff') return 'Diff';
    if (
        lower === 'execute' ||
        lower === 'shell' ||
        lower === 'bash' ||
        toolName === 'GeminiBash' ||
        toolName === 'CodexBash'
    ) {
        return 'Bash';
    }
    if (lower === 'read' || lower === 'read_file' || lower === 'readfile') return 'Read';
    if (lower === 'delete' || lower === 'remove') {
        const changes = asRecord(inputObj?.changes);
        if (changes && Object.keys(changes).length > 0) return 'Patch';
        return 'Delete';
    }
    if (lower === 'edit') {
        if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
        return 'Edit';
    }
    if (lower === 'edit_file' || lower === 'editfile') {
        if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
        return 'Edit';
    }
    if (lower === 'write') {
        const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
        return hasTodos ? 'TodoWrite' : 'Write';
    }
    if (lower === 'write_file' || lower === 'writefile') {
        const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
        return hasTodos ? 'TodoWrite' : 'Write';
    }

    if (lower === 'glob') return 'Glob';
    if (lower === 'grep') return 'Grep';
    if (lower === 'ls') return 'LS';
    if (lower === 'web_fetch' || lower === 'webfetch') return 'WebFetch';
    if (lower === 'web_search' || lower === 'websearch') return 'WebSearch';

    if (lower === 'search') {
        const hasQuery =
            !!firstNonEmptyString(inputObj?.query) ||
            !!firstNonEmptyString(inputObj?.pattern) ||
            !!firstNonEmptyString(inputObj?.text);
        // Gemini internal "search" often has only items/locations and is intentionally minimal/hidden.
        return hasQuery ? 'CodeSearch' : toolName;
    }

    if (lower === 'unknown tool') {
        const title =
            firstNonEmptyString(inputObj?.title) ??
            firstNonEmptyString(asRecord(inputObj?.toolCall)?.title) ??
            null;
        if (title === 'Workspace Indexing Permission') return 'WorkspaceIndexingPermission';
    }

    return toolName;
}

function resolveSpecificAcpWrappedToolName(toolName: string, input: unknown): string | null {
    const inputObj = asRecord(input);
    const acpTitle = firstNonEmptyString(asRecord(inputObj?._acp)?.title) ?? firstNonEmptyString(inputObj?.title);
    if (!acpTitle || acpTitle.includes(' ')) return null;

    const normalizedToolName = toolName.trim().toLowerCase();
    const normalizedAcpTitle = acpTitle.trim().toLowerCase();
    if (normalizedToolName === normalizedAcpTitle) return null;

    if ((normalizedToolName === 'read' || normalizedToolName === 'read_file' || normalizedToolName === 'readfile') && normalizedAcpTitle === 'web_fetch') {
        return 'WebFetch';
    }
    if (normalizedToolName === 'search' && normalizedAcpTitle === 'web_search') {
        return 'WebSearch';
    }

    return null;
}

export function canonicalizeToolNameForRendering(toolName: string, input: unknown, description?: string | null): string {
    const taskCompleteToolName = resolveTaskCompleteToolName(toolName, input, description);
    if (taskCompleteToolName) return taskCompleteToolName;

    const inputObj = asRecord(input);
    const happier = asRecord(asRecord(inputObj)?._happier);
    const canonicalFromHappier = firstNonEmptyString(happier?.canonicalToolName);
    if (canonicalFromHappier) return canonicalFromHappier;

    // Legacy V2 sessions (pre `_happier` rename) used `_happy`.
    const happy = asRecord(asRecord(inputObj)?._happy);
    const canonicalFromHappy = firstNonEmptyString(happy?.canonicalToolName);
    if (canonicalFromHappy) return canonicalFromHappy;

    const specificAcpWrappedToolName = resolveSpecificAcpWrappedToolName(toolName, input);
    if (specificAcpWrappedToolName) return specificAcpWrappedToolName;

    return canonicalizeToolNameNonV2(toolName, input, description);
}
