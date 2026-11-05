// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from "react";

type Snapshot = {
  drafts: ReadonlyMap<string, string>;
  saving: ReadonlySet<string>;
};

/** Settings drafts and pending saves outlive a section, without stale save responses erasing edits. */
export class SettingsDrafts {
  #snapshot: Snapshot = { drafts: new Map(), saving: new Set() };
  #listeners = new Set<() => void>();

  getSnapshot = (): Snapshot => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();

  #publish(snapshot: Snapshot) {
    this.#snapshot = snapshot;
    globalThis.removeEventListener?.("beforeunload", this.#warnBeforeUnload);
    if (snapshot.drafts.size || snapshot.saving.size) {
      globalThis.addEventListener?.("beforeunload", this.#warnBeforeUnload);
    }
    for (const listener of this.#listeners) listener();
  }

  change(key: string, value: string | undefined) {
    const drafts = new Map(this.#snapshot.drafts);
    if (value === undefined) drafts.delete(key);
    else drafts.set(key, value);
    this.#publish({ ...this.#snapshot, drafts });
  }

  async save(
    key: string,
    submittedValue: string,
    action: () => Promise<unknown>,
  ): Promise<boolean> {
    if (this.#snapshot.saving.has(key)) return false;
    this.#publish({ ...this.#snapshot, saving: new Set([...this.#snapshot.saving, key]) });
    try {
      await action();
      if (this.#snapshot.drafts.get(key) === submittedValue) this.change(key, undefined);
      return true;
    } finally {
      const saving = new Set(this.#snapshot.saving);
      saving.delete(key);
      this.#publish({ ...this.#snapshot, saving });
    }
  }
}

export const contextDrafts = new SettingsDrafts();
export const limitDrafts = new SettingsDrafts();

export function useSettingsDrafts(store: SettingsDrafts) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
