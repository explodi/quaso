// SPDX-License-Identifier: MIT
import type { UploadFileResult } from "@quaso/core";
import type { EntryColumns } from "./entries.ts";

export type ExistingSourceString = {
  id: number;
  key: string;
  display_key: string;
  kind: string;
  source: string;
  source_hash: string;
  position: number;
  active: number;
};

export type SourceChange =
  | { type: "added"; entry: EntryColumns; position: number }
  | {
      type: "restored" | "changed" | "moved" | "unchanged";
      entry: EntryColumns;
      position: number;
      previous: ExistingSourceString;
      sourceChanged: boolean;
    };

/** Compare source rows without I/O; hidden rows retain their identity when restored. */
export function diffSourceStrings(entries: EntryColumns[], existing: ExistingSourceString[]) {
  const byKey = new Map(existing.map((row) => [row.key, row]));
  const counts: Omit<UploadFileResult, "path" | "status"> = {
    added: 0,
    changed: 0,
    removed: 0,
    restored: 0,
    moved: 0,
    unchanged: 0,
  };
  const seen = new Set<string>();
  const changes = entries.map((entry, position): SourceChange => {
    seen.add(entry.key);
    const previous = byKey.get(entry.key);
    if (previous === undefined) {
      counts.added++;
      return { type: "added", entry, position };
    }
    const sourceChanged = previous.source_hash !== entry.sourceHash || previous.kind !== entry.kind;
    const moved = previous.position !== position;
    const change = { entry, position, previous, sourceChanged };
    if (previous.active === 0) {
      counts.restored++;
      return { ...change, type: "restored" };
    }
    if (sourceChanged) {
      counts.changed++;
      if (moved) counts.moved++;
      return { ...change, type: "changed" };
    }
    if (moved) {
      counts.moved++;
      return { ...change, type: "moved" };
    }
    counts.unchanged++;
    return { ...change, type: "unchanged" };
  });
  const removed = existing.filter((row) => row.active === 1 && !seen.has(row.key));
  counts.removed = removed.length;
  return { changes, removed, counts };
}
