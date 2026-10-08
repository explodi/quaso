// SPDX-License-Identifier: MIT
import { Kbd } from "./Typography.tsx";
import { Button } from "./Button.tsx";
/** A small button with a token, such as a placeholder the translator can insert. */
import type { ButtonHTMLAttributes } from "react";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: "placeholder" | "reference" | "neutral";
  /** The keyboard shortcut's number, shown on the chip. */
  shortcut?: number;
}

export function Chip({
  kind = "neutral",
  shortcut,
  className,
  children,
  type,
  ...rest
}: ChipProps) {
  return (
    <Button
      variant="plain"
      type={type ?? "button"}
      className={["chip", `chip-${kind}`, className].filter(Boolean).join(" ")}
      {...rest}
    >
      <span className="chip-text">{children}</span>
      {shortcut !== undefined && (
        <Kbd className="chip-key" aria-hidden="true">
          {shortcut}
        </Kbd>
      )}
    </Button>
  );
}
