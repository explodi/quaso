// SPDX-License-Identifier: MIT
import {
  Button,
  A,
  ThemeSwitch,
  LogoIcon,
  UserIcon,
  Wordmark,
  Dropdown,
  MonitorIcon,
  FileIcon,
  InfoIcon,
  ActivityIcon,
  WarningIcon,
  CheckSquareIcon,
  ChatIcon,
  SparklesIcon,
  FolderIcon,
  HourglassIcon,
} from "@quaso/design-system";
import { ButtonLink } from "./Button.tsx";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/api.ts";
import { useProject } from "../lib/hooks.ts";
import type { Action } from "../lib/permissions.ts";
import { roleLabel } from "../lib/permissions.ts";
import { href, Link, useRoute } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { MainNavigation, type NavigationItem } from "./MainNavigation.tsx";
import { useToast } from "./Toast.tsx";
import { VolunteerDialog } from "./VolunteerDialog.tsx";
import { JobIndicator } from "./JobIndicator.tsx";

export interface NavItem extends NavigationItem {
  /** Shown only to people who may use this page. */
  requires?: Action;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Overview", exact: true, icon: <MonitorIcon /> },
  { to: "/sources", label: "Sources", icon: <FileIcon /> },
  { to: "/glossary", label: "Glossary", icon: <InfoIcon /> },
  {
    to: "/review",
    label: "Review queue",
    requires: "review",
    group: "Contribute",
    icon: <CheckSquareIcon />,
  },
  {
    to: "/contributions",
    label: "My contributions",
    requires: "suggest",
    group: "Contribute",
    icon: <ChatIcon />,
  },
  {
    to: "/issues",
    label: "Source issues",
    requires: "issues",
    group: "Contribute",
    icon: <WarningIcon />,
  },
  { to: "/activity", label: "Activity", group: "Contribute", icon: <ActivityIcon /> },
  { to: "/jobs", label: "Jobs", requires: "translate", group: "Manage", icon: <HourglassIcon /> },
  { to: "/usage", label: "Usage", requires: "usage", group: "Manage", icon: <SparklesIcon /> },
  { to: "/team", label: "Team", requires: "team", group: "Manage", icon: <UserIcon /> },
  {
    to: "/settings",
    label: "Settings",
    requires: "settings",
    group: "Manage",
    icon: <FolderIcon />,
  },
  { to: "/admin", label: "Instance", requires: "settings", group: "Manage", icon: <MonitorIcon /> },
];

function UserMenu() {
  const session = useSession();
  const toast = useToast();
  const [volunteer, setVolunteer] = useState(false);
  const user = session.user!;

  const signOut = async () => {
    try {
      await session.signOut();
      toast.show("Signed out.");
    } catch (error) {
      toast.show(errorMessage(error), "error");
    }
  };

  return (
    <>
      <Dropdown
        name="Account"
        variant="plain"
        className="user-menu"
        triggerClassName="user-button"
        label={
          <>
            {user.avatarUrl ? (
              <img className="avatar" src={user.avatarUrl} alt="" width={24} height={24} />
            ) : (
              <UserIcon />
            )}
            <span className="user-name">{user.displayName}</span>
            <span className="sr-only">Account</span>
          </>
        }
      >
        <p className="menu-caption">
          {roleLabel(user.role)}
          {user.languages && user.languages.length > 0 && ` · ${user.languages.join(", ")}`}
        </p>
        <Link className="menu-item" to="/account">
          Account
        </Link>
        {session.can("volunteer") &&
          (user.volunteerRequest?.status === "pending" ? (
            <p className="menu-caption" role="status">
              Volunteer request pending
            </p>
          ) : (
            <Button
              variant="plain"
              type="button"
              className="menu-item"
              onClick={() => {
                setVolunteer(true);
              }}
            >
              Become a volunteer
            </Button>
          ))}
        <Button variant="plain" type="button" className="menu-item" onClick={signOut}>
          Sign out
        </Button>
      </Dropdown>
      {volunteer && <VolunteerDialog open onClose={() => setVolunteer(false)} />}
    </>
  );
}

function Account() {
  const session = useSession();
  const { location } = useRoute();
  if (session.user) return <UserMenu />;
  const next = location.pathname.startsWith("/signin")
    ? undefined
    : location.pathname + location.search;
  return (
    <ButtonLink size="small" to={href("/signin", { next })}>
      Sign in
    </ButtonLink>
  );
}

/**
 * Keeps `--header-block-size` on the root at the sticky header's height, so focusing an
 * element scrolls it clear of the header (`scroll-padding-top`), however the header wraps.
 */
function useHeaderSize() {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--header-block-size", `${element.offsetHeight}px`);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return header;
}

export function Layout({ children, fill }: { children: ReactNode; fill?: boolean }) {
  const session = useSession();
  const project = useProject();
  const header = useHeaderSize();
  const name = project.data?.name ?? "Quaso";
  const logo = project.data?.logoUrl;
  const nav = NAV_ITEMS.filter((item) => !item.requires || session.can(item.requires));
  const { pathname } = useRoute();
  const auth = [
    "/signin",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
    "/setup",
  ].some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const compact = fill || auth;
  return (
    <div className={`app app-workspace${fill ? " app-fill" : ""}${compact ? " app-focus" : ""}`}>
      <A className="skip-link" href="#main">
        Skip to content
      </A>
      <header className="header" ref={header}>
        <Link to="/" className="brand" title={name}>
          {logo && /^(https:|\/)/.test(logo) ? (
            <img className="brand-logo" src={logo} alt="" width={28} height={28} />
          ) : name === "Quaso" ? null : (
            <LogoIcon className="brand-logo" size={24} />
          )}
          {name === "Quaso" ? <Wordmark /> : <span className="brand-name">{name}</span>}
        </Link>
        <MainNavigation items={nav} workspace compact={compact} />
        <div className="header-end">
          <ThemeSwitch variant="menu" />
          <Account />
        </div>
      </header>
      {project.error !== undefined && project.data === undefined && (
        <div className="banner" role="alert">
          {errorMessage(project.error)}
        </div>
      )}
      <main id="main" className={fill ? "main main-fill" : "main"} tabIndex={-1}>
        {children}
      </main>
      {!fill && <Footer />}
      {session.can("translate") && <JobIndicator key={session.user?.id} />}
    </div>
  );
}

/** Only web links from the project's settings: no `javascript:` or other schemes. */
export function safeLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function Footer() {
  const project = useProject();
  const links = (project.data?.links ?? [])
    .map((link) => ({ label: link.label, url: safeLink(link.url) }))
    .filter((link): link is { label: string; url: string } => link.url !== null);
  return (
    <footer className="footer">
      {links.length > 0 && (
        <ul className="footer-links">
          {links.map((link) => (
            <li key={link.url}>
              <A href={link.url} rel="noopener noreferrer">
                {link.label}
              </A>
            </li>
          ))}
        </ul>
      )}
      <p>Translated with Quaso, open source under the MIT licence.</p>
    </footer>
  );
}
