// SPDX-License-Identifier: MIT
/**
 * Edits not saved yet, by language and string, while the page stays open: drafts left
 * behind, saves running in the background while the translator goes on to the next string,
 * and saves that failed. A failed save keeps its edit, so opening the string again shows it.
 *
 * A string with a save running isn't shown in the editor until the save is done, so two saves
 * of the same string never race.
 */
import { useSyncExternalStore } from "react";
import type { Draft } from "../../lib/masking.ts";

export interface UnsavedEdit {
  draft: Draft;
  /** The translation's revision the edit started from. */
  baseRevision: number;
  /** Why its background save failed; undefined for a draft that was never sent. */
  error?: unknown;
}

export type SaveState = "saving" | "failed" | null;

const unsaved = new Map<string, UnsavedEdit>();
const running = new Set<string>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

export function unsavedEdit(key: string): UnsavedEdit | undefined {
  return unsaved.get(key);
}

/** Keeps the edit to show when the string is opened again; null forgets it. */
export function keepUnsavedEdit(key: string, edit: UnsavedEdit | null): void {
  if (edit) unsaved.set(key, edit);
  else unsaved.delete(key);
  publish();
}

/**
 * Runs `send`, then `refresh`, with the string showing as saving until both are done. When
 * `send` fails, the edit is kept with the error, and the promise rejects with that error.
 */
export async function saveInBackground(
  key: string,
  edit: Omit<UnsavedEdit, "error">,
  send: () => Promise<unknown>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  running.add(key);
  unsaved.delete(key);
  publish();
  try {
    await send();
  } catch (error) {
    running.delete(key);
    unsaved.set(key, { ...edit, error });
    publish();
    throw error;
  }
  // Saving lasts until the refresh is done, so the string and its row then show the saved text.
  await refresh().catch(() => {});
  running.delete(key);
  publish();
}

export function hasRunningSaves(): boolean {
  return running.size > 0;
}

export function saveState(key: string): SaveState {
  if (running.has(key)) return "saving";
  if (unsaved.get(key)?.error !== undefined) return "failed";
  return null;
}

/** Whether the string's save is running, or failed and still holds its edit. */
export function useSaveState(key: string): SaveState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => saveState(key),
  );
}
