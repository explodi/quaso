// SPDX-License-Identifier: MIT
/**
 * String states (design §5.4, §5.9): each has a shape, a label and a colour, so colour is
 * never the only signal. Untranslated is an empty square, translated (green) a half-filled
 * one, proofread (blue) a square with a check; outdated adds a clock, pending an hourglass
 * and QA problems a warning triangle.
 */
import type { StringSummary } from "@quaso/core";
import {
  COLOUR_DESCRIPTIONS,
  COLOUR_LABELS,
  colourOf,
  flagsOf,
  type StateColour,
  stateSentence,
} from "../lib/states.ts";
import {
  CheckSquareIcon,
  ClockIcon,
  EmptySquareIcon,
  HalfSquareIcon,
  HourglassIcon,
  WarningIcon,
} from "./Icons.tsx";

export function StateIcon({ colour, size }: { colour: StateColour; size?: number }) {
  const className = `state-icon state-${colour}`;
  if (colour === "blue") return <CheckSquareIcon className={className} size={size} />;
  if (colour === "green") return <HalfSquareIcon className={className} size={size} />;
  return <EmptySquareIcon className={className} size={size} />;
}

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

/** A colour change, as in the history: icon and label before and after. */
export function ColourLabel({ colour }: { colour: StateColour }) {
  return (
    <span className={`colour-label colour-${colour}`}>
      <StateIcon colour={colour} />
      {COLOUR_LABELS[colour]}
    </span>
  );
}
