// SPDX-License-Identifier: MIT
/**
 * An error, in words for people, with the details the API gave and a way to try again, or
 * to sign in when the session has ended.
 */
import type { ReactNode } from "react";
import { ApiError, errorMessage, isApiError } from "../lib/api.ts";
import { href } from "../lib/match.ts";
import { Button, ButtonLink } from "./Button.tsx";
import { WarningIcon } from "./Icons.tsx";

/** "Sign in", coming back to this page afterwards; none on the sign-in pages themselves. */
function signInLink(): string | null {
  if (typeof location === "undefined" || /^\/(signin|signup)(\/|$)/.test(location.pathname)) {
    return null;
  }
  return href("/signin", { next: location.pathname + location.search });
}

export function ErrorMessage({
  error,
  title,
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  const details =
    error instanceof ApiError
      ? error.details
          .map((detail) =>
            [detail.file, detail.key, detail.language, detail.path, detail.message]
              .filter(Boolean)
              .join(" · "),
          )
          .filter(Boolean)
      : [];
  const signIn = isApiError(error, "unauthorized") ? signInLink() : null;
  return (
    <div className="notice notice-error" role="alert">
      <span className="notice-icon">
        <WarningIcon />
      </span>
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        <p>{errorMessage(error)}</p>
        {details.length > 0 && (
          <ul className="notice-details">
            {details.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        )}
        {(signIn || onRetry) && (
          <div className="actions">
            {signIn && (
              <ButtonLink to={signIn} size="small" variant="primary">
                Sign in
              </ButtonLink>
            )}
            {onRetry && (
              <Button size="small" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A neutral or warning message box. */
export function Notice({
  kind = "info",
  title,
  children,
  icon,
}: {
  kind?: "info" | "warning" | "success";
  title?: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={`notice notice-${kind}`}>
      {icon && <span className="notice-icon">{icon}</span>}
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        {children}
      </div>
    </div>
  );
}
