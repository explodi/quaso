// SPDX-License-Identifier: MIT
import { H1, H2, Card, Notice, InfoIcon, QuasoMascot, PixelPattern } from "@quaso/design-system";

/** The frame of the sign-in pages, and what they share. */
import type { ReactNode } from "react";
import { useDocumentTitle, useProject } from "../../lib/hooks.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";

export function AuthCard({
  title,
  children,
  footer,
  description,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  description?: string;
}) {
  useDocumentTitle(title);
  const project = useProject();
  return (
    <div className="page auth-page">
      <div className="auth-layout">
        <aside className="auth-context" aria-label="Your translation workspace">
          <QuasoMascot decorative />
          <p className="workspace-eyebrow">Your translation workspace</p>
          <H2 ui>{project.data?.name ?? "Welcome to Quaso"}</H2>
          <p className="muted">
            {project.data?.description ||
              "One place for your source strings, translations and reviews."}
          </p>
          <Link to="/">Browse the project →</Link>
          <PixelPattern tone="mint" className="auth-pattern" />
        </aside>
        <div className="auth-form-area">
          <Card className="auth-card">
            <div className="auth-heading">
              <H1 ui>{title}</H1>
              {description && <p className="muted">{description}</p>}
            </div>
            {children}
          </Card>
          {footer && <div className="auth-footer">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

export function NoAccounts() {
  const session = useSession();
  if (session.accounts || session.loading) return null;
  return (
    <Notice kind="warning" icon={<InfoIcon />} title="Accounts aren't available yet">
      <p>
        This server doesn't support signing in yet. Everything in the project can still be read
        without an account.
      </p>
    </Notice>
  );
}

/** At least 10 characters, as the service requires. */
export const PASSWORD_MIN = 10;

export function passwordHint(password: string): string {
  const missing = PASSWORD_MIN - [...password].length;
  return missing > 0
    ? `At least ${PASSWORD_MIN} characters: ${missing} more to go.`
    : `At least ${PASSWORD_MIN} characters: long enough.`;
}
