// SPDX-License-Identifier: MIT
/** Buttons: text buttons in four variants, icon buttons with a label, and links that look like buttons. */
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";
import { A } from "./Controls.tsx";
import { Link, type LinkProps } from "../lib/router.tsx";
import { SpinnerIcon } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "plain";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "small" | "medium";
  /**
   * Shows a spinner and ignores clicks while an action runs. The button stays focusable
   * (`aria-disabled`, not `disabled`, even when `disabled` is also set): disabling the
   * focused button would drop keyboard focus to the page's body (WCAG 2.4.3).
   */
  busy?: boolean;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

function classes(variant: ButtonVariant, size: "small" | "medium", extra?: string): string {
  if (variant === "plain") return ["button-plain", extra].filter(Boolean).join(" ");
  return ["btn", `btn-${variant}`, size === "small" ? "btn-small" : "", extra ?? ""]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "secondary",
  size = "medium",
  busy,
  icon,
  className,
  type,
  disabled,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={classes(variant, size, className)}
      disabled={disabled && !busy}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      {...rest}
      onClick={(event) => {
        if (busy) {
          // Also keeps a busy submit button from submitting its form again.
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {busy ? <SpinnerIcon /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The accessible name, also shown as a tooltip. */
  label: string;
  icon: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, icon, className, type, ...rest }: IconButtonProps) {
  return (
    <Button
      variant="plain"
      type={type ?? "button"}
      className={className ? `icon-btn ${className}` : "icon-btn"}
      aria-label={label}
      title={label}
      {...rest}
    >
      {icon}
    </Button>
  );
}

export function AnchorButton({
  variant = "secondary",
  size = "medium",
  className,
  ...props
}: ComponentProps<"a"> & { variant?: ButtonVariant; size?: "small" | "medium" }) {
  return <A className={classes(variant, size, className)} {...props} />;
}

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: "small" | "medium";
  icon?: ReactNode;
}

/** A link within the website that looks like a button. */
export function ButtonLink({
  variant = "secondary",
  size = "medium",
  icon,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={classes(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
