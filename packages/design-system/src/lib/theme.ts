// SPDX-License-Identifier: MIT
/**
 * Themes (design §5.9): the system's setting by default, or light or dark, remembered in
 * this browser. The choice is the `data-theme` attribute on `<html>`, which the colours in
 * `styles/theme.css` follow; without it, they follow `prefers-color-scheme`.
 */
import { useSyncExternalStore } from "react";

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const STORAGE_KEY = "quaso.theme";

export function parseTheme(value: unknown): ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice) ? (value as ThemeChoice) : "system";
}

/** The remembered choice. Storage can be missing or refuse access (private windows). */
export function readStoredTheme(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): ThemeChoice {
  try {
    return parseTheme(storage?.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function storeTheme(
  choice: ThemeChoice,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage(),
): void {
  try {
    if (choice === "system") storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, choice);
  } catch {
    // Not remembered, then: the choice still applies until the page is reloaded.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Applies a choice to the page. */
export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

let current: ThemeChoice = "system";
const listeners = new Set<() => void>();

/** Applies the remembered choice; the website calls it once, before rendering. */
export function initTheme(): void {
  current = readStoredTheme();
  applyTheme(current);
}

export function setTheme(choice: ThemeChoice): void {
  current = choice;
  applyTheme(choice);
  storeTheme(choice);
  for (const listener of listeners) listener();
}

/** The current choice, and a function to change it. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
  return [choice, setTheme];
}
