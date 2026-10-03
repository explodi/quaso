// SPDX-License-Identifier: MIT
/**
 * The website's pages, by path. Sprint 8's pages (the review queue, my contributions, the
 * team, the settings, LLM usage and jobs, the account, backups and the admin page) slot in
 * here, and in `NAV_ITEMS` (components/Layout.tsx) with the permission they need.
 */
import type { ReactNode } from "react";
import { Redirect, useRoute } from "./lib/router.tsx";
import { fillPattern, href, type Params } from "./lib/match.ts";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { ForgotPassword } from "./pages/auth/ForgotPassword.tsx";
import { ResetPassword } from "./pages/auth/ResetPassword.tsx";
import { Setup } from "./pages/auth/Setup.tsx";
import { SignIn } from "./pages/auth/SignIn.tsx";
import { SignInLink } from "./pages/auth/SignInLink.tsx";
import { SignUp } from "./pages/auth/SignUp.tsx";
import { VerifyEmail } from "./pages/auth/VerifyEmail.tsx";
import { GlossaryPage } from "./pages/GlossaryPage.tsx";
import { IssuesPage } from "./pages/IssuesPage.tsx";
import { SourcesPage } from "./pages/SourcesPage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { EditorPage } from "./pages/editor/EditorPage.tsx";
import { LanguagePage } from "./pages/LanguagePage.tsx";
import { ContributionsPage, ReviewPage } from "./pages/ReviewPage.tsx";
import { TeamPage } from "./pages/TeamPage.tsx";
import { AccountPage } from "./pages/AccountPage.tsx";
import { JobsPage } from "./pages/JobsPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { AdminPage } from "./pages/Admin.tsx";

export interface RouteDefinition {
  path: string;
  render(params: Params): ReactNode;
  /** The editor fills the window, without the footer. */
  fill?: boolean;
}

/**
 * A file in the path, as in /translate/de/menus/main.json?id=4: the editor with ?file=,
 * keeping the rest of the query (the string, the filters) and the fragment.
 */
function FileRedirect({ lang, file }: { lang: string; file: string }) {
  const { query, location } = useRoute();
  return (
    <Redirect
      to={href(fillPattern("/translate/:lang", { lang }), { ...query, file }) + location.hash}
    />
  );
}

export const ROUTES: RouteDefinition[] = [
  { path: "/", render: () => <Dashboard /> },
  { path: "/sources", render: () => <SourcesPage /> },
  { path: "/languages/:lang", render: () => <LanguagePage /> },
  { path: "/translate/:lang", render: () => <EditorPage />, fill: true },
  {
    // A file in the path, as in /translate/de/menus/main.json: the same as ?file=.
    path: "/translate/:lang/*file",
    render: (params) => <FileRedirect lang={params.lang} file={params.file} />,
  },
  { path: "/glossary", render: () => <GlossaryPage /> },
  { path: "/issues", render: () => <IssuesPage /> },
  { path: "/activity", render: () => <ActivityPage /> },
  { path: "/review", render: () => <ReviewPage /> },
  { path: "/contributions", render: () => <ContributionsPage /> },
  { path: "/team", render: () => <TeamPage /> },
  { path: "/account", render: () => <AccountPage /> },
  { path: "/jobs", render: () => <JobsPage /> },
  { path: "/usage", render: () => <UsagePage /> },
  { path: "/settings", render: () => <SettingsPage /> },
  { path: "/admin", render: () => <AdminPage /> },
  { path: "/signin", render: () => <SignIn /> },
  { path: "/signin/link", render: () => <SignInLink /> },
  { path: "/signup", render: () => <SignUp /> },
  { path: "/forgot-password", render: () => <ForgotPassword /> },
  { path: "/reset-password", render: () => <ResetPassword /> },
  { path: "/verify-email", render: () => <VerifyEmail /> },
  { path: "/setup", render: () => <Setup /> },
];
