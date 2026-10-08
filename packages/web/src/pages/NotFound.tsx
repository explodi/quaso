// SPDX-License-Identifier: MIT
import { H1 } from "@quaso/design-system";
/** The page for addresses the website doesn't know. */
import { ButtonLink } from "../components/Button.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";

export function NotFound({
  title = "Page not found",
  message,
}: {
  title?: string;
  message?: string;
}) {
  useDocumentTitle(title);
  return (
    <div className="page narrow not-found">
      <H1>{title}</H1>
      <p>{message ?? "There is nothing at this address. The link may be old, or mistyped."}</p>
      <ButtonLink variant="primary" to="/">
        Go to the dashboard
      </ButtonLink>
    </div>
  );
}
