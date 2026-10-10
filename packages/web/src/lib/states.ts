// SPDX-License-Identifier: MIT
/**
 * String states for display (design §5.4, STR-1): a colour, with the flags outdated,
 * pending and QA problems on top. Colour is never the only signal: each state also has a
 * shape and a label (components/StateBadge.tsx draws them).
 *
 * The colours follow STR-1, the reverse of Crowdin's: green is translated (by the LLM, or
 * imported) and not yet proofread; blue is proofread by a person.
 */
import type { Progress, StateFilter, StringSummary, TranslationInfo } from "@quaso/core";

import { COLOUR_LABELS, type StateColour } from "@quaso/design-system";
export { COLOUR_LABELS, COLOUR_DESCRIPTIONS, type StateColour } from "@quaso/design-system";

export function colourOf(translation: TranslationInfo | null | undefined): StateColour {
  return translation ? translation.colour : "red";
}

export interface StateFlags {
  outdated: boolean;
  pending: number;
  qa: boolean;
}

export function flagsOf(summary: Pick<StringSummary, "translation" | "pending">): StateFlags {
  return {
    outdated: summary.translation?.outdated ?? false,
    pending: summary.pending,
    qa: (summary.translation?.qa.errors ?? 0) > 0,
  };
}

/** The state as one sentence, for screen readers and tooltips: "Translated, outdated, 2 pending". */
export function stateSentence(summary: Pick<StringSummary, "translation" | "pending">): string {
  const flags = flagsOf(summary);
  const parts = [COLOUR_LABELS[colourOf(summary.translation)]];
  if (flags.outdated) parts.push("outdated");
  if (flags.pending > 0) parts.push(`${flags.pending} pending`);
  if (flags.qa) parts.push("QA problems");
  return parts.join(", ");
}

/**
 * What "outdated" means, and what players get meanwhile: said the same way wherever an
 * outdated translation appears, since the word alone doesn't tell.
 */
export function outdatedExplanation(sourceLanguageName: string, count = 1): string {
  const these = count === 1 ? "this was" : "these were";
  const translation = count === 1 ? "translation" : "translations";
  return (
    `The ${sourceLanguageName} changed after ${these} translated. Players still get the old ` +
    `${translation} until someone updates or approves ${count === 1 ? "it" : "them"}.`
  );
}

export const FILTER_LABELS: Record<StateFilter, string> = {
  untranslated: "Untranslated",
  green: "Translated (green)",
  blue: "Proofread (blue)",
  outdated: "Outdated",
  pending: "Pending",
  qa: "QA problems",
};

/** How many strings of a file or language a filter would show. */
export function filterCount(progress: Progress, filter: StateFilter): number {
  switch (filter) {
    case "untranslated":
      return progress.untranslated;
    case "green":
      return progress.green;
    case "blue":
      return progress.blue;
    case "outdated":
      return progress.outdated;
    case "pending":
      return progress.pending;
    case "qa":
      return progress.qa;
  }
}

/**
 * A file or language with nothing left to do for translators: every string translated and
 * up to date, without quality problems. ("Hide completed" hides these.)
 */
export function isCompleted(progress: Progress): boolean {
  return (
    progress.strings > 0 &&
    progress.untranslated === 0 &&
    progress.outdated === 0 &&
    progress.qa === 0
  );
}
