// SPDX-License-Identifier: MIT
/** Translation states pair a colour with a shape and a readable name. */
import type { ReactNode } from "react";
import { CheckSquareIcon, EmptySquareIcon, HalfSquareIcon } from "./Icons.tsx";

export type StateColour = "red" | "green" | "blue";

export const COLOUR_LABELS: Record<StateColour, string> = {
  red: "Untranslated",
  green: "Translated",
  blue: "Proofread",
};

export const COLOUR_DESCRIPTIONS: Record<StateColour, string> = {
  red: "No translation yet: the app shows the English.",
  green: "Translated by the LLM (or imported), waiting for a person to proofread it.",
  blue: "Proofread: written or approved by a person.",
};

/** A decorative state shape; pair it with a visible label or an accessible sentence. */
export function StateIcon({ colour, size }: { colour: StateColour; size?: number }) {
  const className = `state-icon state-${colour}`;
  if (colour === "blue") return <CheckSquareIcon className={className} size={size} />;
  if (colour === "green") return <HalfSquareIcon className={className} size={size} />;
  return <EmptySquareIcon className={className} size={size} />;
}

export function ColourLabel({ colour, children }: { colour: StateColour; children?: ReactNode }) {
  return (
    <span className={`colour-label colour-${colour}`}>
      <StateIcon colour={colour} />
      {children ?? COLOUR_LABELS[colour]}
    </span>
  );
}
