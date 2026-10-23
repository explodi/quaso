// SPDX-License-Identifier: MIT
import { Label, Select } from "@quaso/design-system";
import { Link, useRoute } from "../lib/router.tsx";

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "Project details",
    group: "Project",
    description: "Choose how your project appears to translators and visitors.",
  },
  {
    id: "placeholders",
    label: "Placeholders",
    group: "Project",
    description: "Define the variables translations must preserve, and any language exceptions.",
  },
  {
    id: "languages",
    label: "Languages",
    group: "Project",
    description: "Add translation languages and give translators language-specific guidance.",
  },
  {
    id: "files",
    label: "Files & length limits",
    group: "Project",
    description: "Add context for folders and files, and set character limits for translations.",
  },
  {
    id: "requests",
    label: "Language requests",
    group: "Project",
    description: "Let members suggest languages, vote for them, and follow your decisions.",
  },
  {
    id: "llm",
    label: "AI translation",
    group: "Connections",
    description: "Connect a translation provider and control how automatic translations run.",
  },
  {
    id: "email",
    label: "Email delivery",
    group: "Connections",
    description: "Connect your email provider, choose a sender, and test delivery.",
  },
  {
    id: "keys",
    label: "API keys",
    group: "Connections",
    description: "Manage access for the CLI, downloads, and your build tools.",
  },
  {
    id: "backups",
    label: "Backups",
    group: "Data",
    description: "Download a copy of your project and check the latest automatic backup.",
  },
  {
    id: "retention",
    label: "History & retention",
    group: "Data",
    description: "Choose how long to keep replaced source files and automatic backups.",
  },
] as const;

const GROUPS = ["Project", "Connections", "Data"] as const;

/** The same destinations remain available in the sidebar and the compact mobile selector. */
export function SettingsNavigation({ section }: { section: string }) {
  const { navigate } = useRoute();
  return (
    <>
      <nav className="settings-nav" aria-label="Settings">
        {GROUPS.map((group) => (
          <div className="settings-nav-group" key={group}>
            <p className="settings-nav-label">{group}</p>
            <ul>
              {SETTINGS_SECTIONS.filter((item) => item.group === group).map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/settings?section=${item.id}`}
                    className="settings-nav-link"
                    aria-current={item.id === section ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <Label className="settings-mobile-nav">
        <span className="field-label">Settings section</span>
        <Select
          value={section}
          onChange={(event) => navigate(`/settings?section=${event.target.value}`)}
        >
          {GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {SETTINGS_SECTIONS.filter((item) => item.group === group).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Label>
    </>
  );
}
