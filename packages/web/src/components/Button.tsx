// SPDX-License-Identifier: MIT
/** Router links use the same presentation as the shared button primitives. */
import type { ReactNode } from "react";
import { buttonClassName, type ButtonVariant } from "@quaso/design-system";
import { Link, type LinkProps } from "../lib/router.tsx";

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
    <Link className={buttonClassName(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
