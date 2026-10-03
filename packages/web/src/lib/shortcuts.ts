// SPDX-License-Identifier: MIT
/**
 * The editor's keyboard shortcuts (design §5.9, S7.6), as a pure function of the key event,
 * and the list the shortcuts dialog shows.
 */

export type ShortcutAction =
  | { type: "save" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "nextToDo" }
  | { type: "previousToDo" }
  | { type: "copySource" }
  | { type: "insert"; index: number }
  | { type: "help" };

export interface KeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The action for a key press, or null.
 *
 * - Ctrl+Enter (⌘+Enter on a Mac): save or suggest, then go to the next string to do.
 * - Alt+↓ and Alt+↑: the next and the previous string.
 * - Ctrl+Shift+C (⌘+Shift+C): copy the English into the input.
 * - Alt+1…9, or Ctrl+1…9 (Control+1…9 on a Mac): insert the nth placeholder or reference.
 *   Browsers keep Ctrl+1…9 for switching tabs on Windows and Linux, hence Alt there. On a
 *   Mac, Option+digit types characters on most layouts ({ } [ ] | @ # on German, Spanish,
 *   French, Nordic and UK ones, exactly what placeholders are made of), so it is left
 *   alone unless it typed nothing but the digit.
 * - `?` outside text inputs: the list of shortcuts.
 *
 * Digits are read from `code`, so Ctrl+digit works with any keyboard layout.
 */
export function shortcutFor(
  event: KeyInput,
  inTextInput: boolean,
  mac: boolean = isMac(),
): ShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && !event.shiftKey && event.key === "Enter") return { type: "save" };
  if (event.altKey && !mod && event.shiftKey) {
    if (event.key === "ArrowDown") return { type: "nextToDo" };
    if (event.key === "ArrowUp") return { type: "previousToDo" };
  }
  if (event.altKey && !mod && !event.shiftKey) {
    if (event.key === "ArrowDown") return { type: "next" };
    if (event.key === "ArrowUp") return { type: "previous" };
  }
  if (
    mod &&
    event.shiftKey &&
    !event.altKey &&
    (event.code === "KeyC" || event.key.toLowerCase() === "c")
  ) {
    return { type: "copySource" };
  }
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (digit && !event.shiftKey) {
    const insert: ShortcutAction = { type: "insert", index: Number(digit[1]) - 1 };
    // Ctrl+Alt is AltGr on Windows, which types characters: neither branch takes it.
    if (mod && !event.altKey) return insert;
    if (event.altKey && !mod && (!mac || event.key === digit[1])) return insert;
  }
  if (event.key === "?" && !mod && !event.altKey && !inTextInput) return { type: "help" };
  return null;
}

/** Whether the element takes text, where plain keys like `?` must type. */
export function isTextInput(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      element.type,
    );
  }
  return (element as HTMLElement).isContentEditable === true;
}

/** Whether the platform uses ⌘ rather than Ctrl. */
export function isMac(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

export interface ShortcutHelp {
  keys: string[][];
  description: string;
}

/** The shortcuts, for the dialog: each is a list of alternatives, each a list of keys. */
export function shortcutList(mac: boolean): ShortcutHelp[] {
  const mod = mac ? "⌘" : "Ctrl";
  const alt = mac ? "⌥" : "Alt";
  return [
    { keys: [[mod, "Enter"]], description: "Save (or suggest), then go to the next string to do" },
    { keys: [[alt, "↓"]], description: "Next string" },
    { keys: [[alt, "↑"]], description: "Previous string" },
    { keys: [[alt, "Shift", "↓"]], description: "Next string to do" },
    { keys: [[alt, "Shift", "↑"]], description: "Previous string to do" },
    { keys: [[mod, "Shift", "C"]], description: "Copy the English into the input" },
    {
      // Browsers keep Ctrl+digits for tabs on Windows and Linux, and ⌥+digits type
      // characters on a Mac: each platform gets the combination that works there.
      keys: mac ? [["Control", "1…9"]] : [["Alt", "1…9"]],
      description: "Insert the first to ninth placeholder or reference",
    },
    { keys: [["↑"], ["↓"], ["Home"], ["End"]], description: "Move in the string list" },
    { keys: [["Space"]], description: "Select the string (in the list), for bulk actions" },
    { keys: [["Enter"]], description: "Open the string (in the list)" },
    { keys: [["?"]], description: "Show this list (outside text inputs)" },
    { keys: [["Esc"]], description: "Close a dialog" },
  ];
}
