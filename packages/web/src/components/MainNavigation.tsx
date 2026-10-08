// SPDX-License-Identifier: MIT
import { NavLink, useRoute } from "../lib/router.tsx";
import { Dropdown } from "@quaso/design-system";

export interface NavigationItem {
  to: string;
  label: string;
  exact?: boolean;
  group?: "Workspace" | "Management";
}

/** Frequent destinations stay visible; every destination remains available in the disclosure. */
export function MainNavigation({ items }: { items: NavigationItem[] }) {
  const { location } = useRoute();
  const current = items.find((item) => {
    if (item.exact) return location.pathname === item.to;
    return location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
  });
  const primary = items.filter((item) => !item.group);
  const secondary = items.filter((item) => item.group);

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
