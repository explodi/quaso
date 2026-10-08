// SPDX-License-Identifier: MIT
/**
 * An error, in words for people, with the details the API gave and a way to try again, or
 * to sign in when the session has ended.
 */
import { Notice, Button, WarningIcon } from "@quaso/design-system";
import { ApiError, errorMessage, isApiError } from "../lib/api.ts";
import { href } from "../lib/match.ts";
import { ButtonLink } from "./Button.tsx";

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
    <Notice kind="error" role="alert" title={title} icon={<WarningIcon />}>
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
    </Notice>
  );
}
