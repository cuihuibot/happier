import { maybeParseJson } from '@happier-dev/protocol';

import { asRecord, firstNonEmptyString } from './_shared';

/**
 * The completion summary a turn-completion row stores.
 *
 * Providers publish it as the tool input, but some completion events only carry it on the tool
 * result, so both are read through this one owner and the input wins when both are present.
 */
export function resolveTaskCompleteSummary(tool: { input?: unknown; result?: unknown }): string | null {
    const fromInput = firstNonEmptyString(asRecord(maybeParseJson(tool.input))?.summary);
    if (fromInput) return fromInput;
    return firstNonEmptyString(asRecord(maybeParseJson(tool.result))?.summary);
}

export function resolveTaskCompleteSummaryLead(tool: { input?: unknown; result?: unknown }): string | null {
    const summary = resolveTaskCompleteSummary(tool);
    if (!summary) return null;
    return firstNonEmptyString(summary.split('\n').find((line) => line.trim().length > 0));
}
