const OPAQUE_CITATION_PATTERN = /\uE200cite((?:\uE202[^\uE200\uE201\uE202]+)+)\uE201/g;
const OPAQUE_CITATION_REFERENCE_PATTERN = /^turn\d+[A-Za-z_]+\d+$/;

export function normalizeOpaqueCitationMarkers(
    markdown: string,
    options: Readonly<{
        escapeMarkdown?: boolean;
        hideIncompleteTrailingMarker?: boolean;
    }> = {},
): string {
    const citationNumbers = new Map<string, number>();
    let displayMarkdown = markdown;
    if (options.hideIncompleteTrailingMarker === true) {
        const incompleteStart = displayMarkdown.lastIndexOf('\uE200');
        if (
            incompleteStart >= 0 &&
            displayMarkdown.indexOf('\uE201', incompleteStart) < 0
        ) {
            displayMarkdown = displayMarkdown.slice(0, incompleteStart);
        }
    }

    return displayMarkdown.replace(OPAQUE_CITATION_PATTERN, (fullMatch, encodedReferences: string) => {
        const references = encodedReferences
            .split('\uE202')
            .filter((reference) => reference.length > 0);
        if (
            references.length === 0 ||
            references.some((reference) => !OPAQUE_CITATION_REFERENCE_PATTERN.test(reference))
        ) {
            return fullMatch;
        }

        const numbers: number[] = [];
        for (const reference of references) {
            let citationNumber = citationNumbers.get(reference);
            if (citationNumber === undefined) {
                citationNumber = citationNumbers.size + 1;
                citationNumbers.set(reference, citationNumber);
            }
            if (!numbers.includes(citationNumber)) numbers.push(citationNumber);
        }
        numbers.sort((left, right) => left - right);

        const label = `[${numbers.join(', ')}]`;
        return options.escapeMarkdown === false
            ? label
            : `〔${numbers.join(', ')}〕`;
    });
}
