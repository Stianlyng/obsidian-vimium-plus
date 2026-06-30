/**
 * Generate `count` prefix-free hint strings from the given alphabet, using
 * Vimium's algorithm: build strings by prepending characters, slice off the
 * interior (non-terminal) nodes, then reverse each string so that no label is a
 * prefix of another. Shorter labels are produced first, so common targets get
 * one-key hints.
 */
export function generateHintStrings(count: number, chars: string): string[] {
	const alphabet = chars.length > 0 ? chars.split("") : ["s", "a", "d", "f"];

	if (count <= 0) return [];

	const hints: string[] = [""];
	let offset = 0;

	while (hints.length - offset < count || hints.length === 1) {
		const hint = hints[offset++];
		for (const ch of alphabet) {
			hints.push(ch + hint);
		}
	}

	const result = hints.slice(offset, offset + count);

	// Reverse each string (so suffix-sharing becomes prefix-distinct → prefix
	// free) and sort for a stable, tidy ordering.
	return result.map((s) => s.split("").reverse().join("")).sort();
}
