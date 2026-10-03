// SPDX-License-Identifier: MIT
import type { UploadResult } from "@quaso/core";
import { type KeyedString, KeyIndex } from "./keys.ts";

export type RenameCandidate = {
  id: number;
  fileId: number;
  file: string;
  position: number;
  kind: string;
  sourceHash: string;
};

/** All translatable keys, including hidden strings, for unambiguous references. */
export type RenameKey = KeyedString & { id: number; file_id: number };

/** Suggest matching removed/added keys; callers exclude explicitly renamed strings. */
export function suggestUploadRenames(
  removed: RenameCandidate[],
  added: RenameCandidate[],
  translated: ReadonlySet<number>,
  keys: RenameKey[],
): UploadResult["renameSuggestions"] {
  const groups = new Map<string, { removed: RenameCandidate[]; added: RenameCandidate[] }>();
  for (const item of added) {
    const identity = englishId(item);
    const group = groups.get(identity);
    if (group === undefined) groups.set(identity, { removed: [], added: [item] });
    else group.added.push(item);
  }
  for (const item of removed) {
    if (translated.has(item.id)) groups.get(englishId(item))?.removed.push(item);
  }
  const pairs: [RenameCandidate, RenameCandidate][] = [];
  for (const group of groups.values()) {
    const old = [...group.removed].sort((a, b) => a.position - b.position);
    const next = [...group.added].sort((a, b) => a.position - b.position);
    if (old.length === 1) {
      pairs.push(...next.map((item): [RenameCandidate, RenameCandidate] => [old[0], item]));
    } else if (next.length === 1) {
      pairs.push(...old.map((item): [RenameCandidate, RenameCandidate] => [item, next[0]]));
    } else {
      for (let i = 0; i < Math.min(old.length, next.length); i++) pairs.push([old[i], next[i]]);
    }
  }
  if (pairs.length === 0) return [];
  pairs.sort(
    ([a, x], [b, y]) =>
      compare(a.file, b.file) || a.position - b.position || x.position - y.position,
  );
  const byFile = new Map<number, RenameKey[]>();
  for (const row of keys) {
    const rows = byFile.get(row.file_id);
    if (rows === undefined) byFile.set(row.file_id, [row]);
    else rows.push(row);
  }
  const indexes = new Map([...byFile].map(([id, rows]) => [id, new KeyIndex(rows)]));
  const byId = new Map(keys.map((row) => [row.id, row]));
  const reference = (item: RenameCandidate) =>
    indexes.get(item.fileId)!.reference(byId.get(item.id)!);
  return pairs.map(([from, to]) => ({ file: from.file, from: reference(from), to: reference(to) }));
}

function englishId(item: RenameCandidate): string {
  return `${item.fileId}\n${item.kind}\n${item.sourceHash}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
