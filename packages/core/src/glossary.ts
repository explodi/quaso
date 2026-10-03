// SPDX-License-Identifier: MIT
/** Unicode word boundaries shared by glossary QA, prompt selection and editor highlights. */
const words = new Intl.Segmenter("en", { granularity: "word" });

/** Offsets of whole-term matches; punctuation and multiword terms keep their boundaries. */
export function glossaryMatches(
  text: string,
  term: string,
  caseSensitive = false,
): { start: number; end: number }[] {
  if (term.length === 0) return [];
  const boundaries = new Set<number>([text.length]);
  for (const segment of words.segment(text)) boundaries.add(segment.index);
  const expected = caseSensitive ? term.normalize("NFC") : term.normalize("NFC").toLowerCase();
  const out: { start: number; end: number }[] = [];
  // Compare slices of the original text: lowercasing can change its UTF-16 length.
  const ends = [...boundaries].sort((a, b) => a - b);
  for (let i = 0; i < ends.length - 1; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const slice = text.slice(ends[i], ends[j]).normalize("NFC");
      const candidate = caseSensitive ? slice : slice.toLowerCase();
      if (candidate === expected) out.push({ start: ends[i], end: ends[j] });
      if (candidate.length > expected.length) break;
    }
  }
  return out;
}
