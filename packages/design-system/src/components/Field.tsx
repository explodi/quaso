// SPDX-License-Identifier: MIT
import { Label, Input } from "./Controls.tsx";
/** A labelled form field with an optional hint and error, wired up for screen readers. */
import { type InputHTMLAttributes, type ReactNode, useId } from "react";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

export function Field({
  label,
  hint,
  error,
  id,
  className,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...rest
}: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={className ? `field ${className}` : "field"}>
      <Label htmlFor={inputId} className="field-label">
        {label}
      </Label>
      <Input
        id={inputId}
        aria-describedby={[describedBy, hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : invalid}
        {...rest}
      />
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
