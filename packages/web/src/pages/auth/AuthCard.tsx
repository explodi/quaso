// SPDX-License-Identifier: MIT
import { H1 } from "../../components/Typography.tsx";
import { Card } from "../../components/Controls.tsx";
/** The frame of the sign-in pages, and what they share. */
import type { ReactNode } from "react";
import { Notice } from "../../components/ErrorMessage.tsx";
import { InfoIcon } from "../../components/Icons.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { useSession } from "../../lib/session.tsx";

export function AuthCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <div className="page auth-page">
      <Card className="auth-card">
        <H1>{title}</H1>
        {children}
      </Card>
      {footer && <div className="auth-footer">{footer}</div>}
    </div>
  );
}

/** Explains that the server has no accounts yet (before Sprint 6's API). */
export function NoAccounts() {
  const session = useSession();
  if (session.accounts || session.loading) return null;
  return (
    <Notice kind="warning" icon={<InfoIcon />} title="Accounts aren't available yet">
      <p>
        This server doesn't support signing in yet. Everything on the website can still be read
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
