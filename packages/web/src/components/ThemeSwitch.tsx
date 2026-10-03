// SPDX-License-Identifier: MIT
import { useId, useSyncExternalStore } from "react";
import { useTheme, type ThemeChoice, THEME_CHOICES } from "../lib/theme.ts";
import { Label, Radio, Select, Switch } from "./Controls.tsx";
import { Dropdown } from "./Dropdown.tsx";
import { MonitorIcon, MoonIcon, SunIcon } from "./Icons.tsx";

const labels: Record<ThemeChoice, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function subscribe(listener: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function useDarkTheme() {
  const [choice] = useTheme();
  const systemDark = useSyncExternalStore(
    subscribe,
    () => matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  return choice === "system" ? systemDark : choice === "dark";
}

export function ThemeSwitch({ variant = "select" }: { variant?: "select" | "switch" | "menu" }) {
  const [theme, setTheme] = useTheme();
  const dark = useDarkTheme();
  const id = useId();
  const Icon = theme === "dark" ? MoonIcon : theme === "light" ? SunIcon : MonitorIcon;
  if (variant === "menu")
    return (
      <Dropdown
        name="Appearance"
        className="theme-menu"
        triggerClassName="icon-btn"
        variant="plain"
        showChevron={false}
        label={
          <>
            <Icon />
            <span className="sr-only">Appearance</span>
          </>
        }
      >
        {THEME_CHOICES.map((choice) => (
          <Label key={choice} className="menu-item">
            <Radio
              name={id}
              value={choice}
              checked={theme === choice}
              onChange={() => setTheme(choice)}
            />
            {labels[choice]}
          </Label>
        ))}
      </Dropdown>
    );
  if (variant === "switch")
    return (
      <Label className="theme-toggle">
        <SunIcon size={16} />
        <Switch
          checked={dark}
          onChange={(event) => setTheme(event.target.checked ? "dark" : "light")}
          aria-label="Dark mode"
        />
        <MoonIcon size={16} />
      </Label>
    );
  return (
    <div className="theme-switch">
      <Label htmlFor={id} className="sr-only">
        Theme
      </Label>
      <Icon className="theme-switch-icon" />
      <Select
        id={id}
        className="theme-select"
        value={theme}
        onChange={(event) => setTheme(event.target.value as ThemeChoice)}
      >
        {THEME_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {labels[choice]}
          </option>
        ))}
      </Select>
    </div>
  );
}
