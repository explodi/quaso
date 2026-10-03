// SPDX-License-Identifier: MIT
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, type ButtonVariant } from "./Button.tsx";
import { ChevronDownIcon } from "./Icons.tsx";

/** A disclosure for links and actions, retaining normal Tab navigation. */
export function Dropdown({
  label,
  name,
  className = "",
  triggerClassName = "",
  variant = "secondary",
  showChevron = true,
  children,
}: {
  label: ReactNode;
  name: string;
  className?: string;
  triggerClassName?: string;
  variant?: ButtonVariant;
  showChevron?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    const actions = panel.current?.querySelectorAll<HTMLElement>(
      "a[href], button:not(:disabled), input",
    );
    const visible = [...(actions ?? [])].filter((action) => action.getClientRects().length > 0);
    const selectedRadio = visible.find((action) => action.matches('input[type="radio"]:checked'));
    (selectedRadio ?? visible[0])?.focus();
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <div
      className={`dropdown ${className}`}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <Button
        variant={variant}
        ref={button}
        className={`dropdown-trigger ${triggerClassName}`}
        aria-expanded={open}
        aria-controls={id}
        title={name}
        onClick={() => setOpen(!open)}
      >
        {label}
        {showChevron && <ChevronDownIcon />}
      </Button>
      {open && (
        <div
          id={id}
          ref={panel}
          className="menu"
          role="group"
          aria-label={name}
          onClick={(event) => {
            const action = (event.target as Element).closest("a[href], button");
            if (!action) return;
            setOpen(false);
            // Navigation manages its own focus; actions return it to their trigger.
            if (action.tagName === "BUTTON") button.current?.focus();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
