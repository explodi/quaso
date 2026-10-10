// SPDX-License-Identifier: MIT
import { Link, NavLink, useRoute } from "../lib/router.tsx";
import { Dropdown } from "@quaso/design-system";
import type { ReactNode } from "react";

export interface NavigationItem {
  to: string;
  label: string;
  exact?: boolean;
  group?: "Workspace" | "Management" | "Contribute" | "Manage";
  icon?: ReactNode;
}

export function MainNavigation({
  items,
  workspace = false,
  compact = false,
}: {
  items: NavigationItem[];
  workspace?: boolean;
  compact?: boolean;
}) {
  const { location } = useRoute();
  const current = items.find((item) => {
    if (item.exact) return location.pathname === item.to;
    return location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
  });
  const primary = items.filter((item) => !item.group);
  const secondary = items.filter((item) => item.group);

  if (workspace) {
    const groups = [undefined, "Contribute", "Manage"] as const;
    const isLanguage = location.pathname.startsWith("/languages/");
    const isEditor = location.pathname.startsWith("/translate/");
    const activePath = isLanguage || isEditor ? "/" : location.pathname;
    const links = groups.map((group) => {
      const entries = items.filter((item) => item.group === group);
      if (entries.length === 0) return null;
      return (
        <div className="workspace-nav-group" key={group ?? "project"}>
          <p className="workspace-nav-label">{group ?? "Project"}</p>
          <ul>
            {entries.map((item) => {
              const active = item.exact
                ? activePath === item.to
                : activePath === item.to || activePath.startsWith(`${item.to}/`);
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="nav-link menu-item"
                    aria-current={active ? "page" : undefined}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      );
    });
    return (
      <nav className={`nav nav-workspace${compact ? " nav-compact" : ""}`} aria-label="Main">
        <div className="workspace-navigation">{links}</div>
        <Dropdown
          variant="plain"
          name="Pages"
          className="nav-overflow workspace-menu"
          triggerClassName="nav-link"
          label={<span>Menu</span>}
        >
          {links}
        </Dropdown>
      </nav>
    );
  }

  return (
    <nav className="nav" aria-label="Main">
      <ul className="nav-primary">
        {primary.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} exact={item.exact} className="nav-link">
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <Dropdown
        variant="plain"
        name="Pages"
        className={`nav-overflow${secondary.length ? "" : " nav-overflow-mobile"}`}
        triggerClassName={`nav-link${current?.group ? " is-current" : ""}`}
        label={
          <>
            <span className="nav-more-label">{current?.group ? current.label : "More"}</span>
            <span className="nav-menu-label">Menu</span>
          </>
        }
      >
        <ul className="nav-overflow-primary">
          {primary.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} exact={item.exact} className="menu-item nav-link">
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        {(["Workspace", "Management"] as const).map((group) => {
          const links = secondary.filter((item) => item.group === group);
          if (links.length === 0) return null;
          return (
            <div className="nav-group" key={group}>
              <p className="menu-caption">{group}</p>
              <ul>
                {links.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} exact={item.exact} className="menu-item nav-link">
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Dropdown>
    </nav>
  );
}
