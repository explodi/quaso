// SPDX-License-Identifier: MIT
/**
 * String states (design §5.4, §5.9): each has a shape, a label and a colour, so colour is
 * never the only signal. Untranslated is an empty square, translated (green) a half-filled
 * one, proofread (blue) a square with a check; outdated adds a clock, pending an hourglass
 * and QA problems a warning triangle.
 */
import { StateIcon, ClockIcon, HourglassIcon, WarningIcon } from "@quaso/design-system";
import type { StringSummary } from "@quaso/core";
import {
  COLOUR_DESCRIPTIONS,
  COLOUR_LABELS,
  colourOf,
  flagsOf,
  stateSentence,
} from "../lib/states.ts";

type Summary = Pick<StringSummary, "translation" | "pending">;

/** The state's icons only, with the whole state as a hidden sentence: for dense lists. */
export function StateMarker({ summary }: { summary: Summary }) {
  const flags = flagsOf(summary);
  const sentence = stateSentence(summary);
  return (
    <span className="state-marker" title={sentence}>
      <StateIcon colour={colourOf(summary.translation)} />
      {flags.outdated && <ClockIcon className="flag-icon flag-outdated" />}
      {flags.pending > 0 && <HourglassIcon className="flag-icon flag-pending" />}
      {flags.qa && <WarningIcon className="flag-icon flag-qa" />}
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

/** The state with its label and flags, all written out. */
export function StateBadge({ summary, describe }: { summary: Summary; describe?: boolean }) {
  const colour = colourOf(summary.translation);
  const flags = flagsOf(summary);
  return (
    <span className="state-badges">
      <span className={`badge badge-${colour}`} title={COLOUR_DESCRIPTIONS[colour]}>
        <StateIcon colour={colour} />
        {COLOUR_LABELS[colour]}
      </span>
      {flags.outdated && (
        <span className="badge badge-flag" title="Made for an older English text">
          <ClockIcon className="flag-outdated" />
          Outdated
        </span>
      )}
      {flags.pending > 0 && (
        <span className="badge badge-flag" title="Suggestions waiting for review">
          <HourglassIcon className="flag-pending" />
          {flags.pending} pending
        </span>
      )}
      {flags.qa && (
        <span className="badge badge-flag badge-qa" title="The translation fails a quality check">
          <WarningIcon className="flag-qa" />
          QA problems
        </span>
      )}
      {describe && <span className="sr-only">{COLOUR_DESCRIPTIONS[colour]}</span>}
    </span>
  );
}
