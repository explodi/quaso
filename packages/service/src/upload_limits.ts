// SPDX-License-Identifier: MIT
import type { UploadRequest } from "@quaso/core";
import { type KeyedString, KeyIndex, parseKeySelector } from "./keys.ts";
import type { Statement } from "./ports.ts";
import { AMBIGUOUS_HINT } from "./rename.ts";

/** Active, translatable strings in active files after the source diff. */
export type LimitTarget = KeyedString & {
  id: number;
  path: string;
  max_length: number | null;
  max_length_locked: number;
};

/** Resolve configured limits and clear omitted locks in uploaded files without I/O. */
export function planUploadLimits(
  limits: NonNullable<UploadRequest["limits"]>,
  targets: LimitTarget[],
  lockedUploadedIds: number[],
  at: number,
): {
  statements: Statement[];
  changes: { id: number; maxLength: number | null }[];
  recheck: number[];
  warnings: string[];
} {
  const byPath = new Map<string, LimitTarget[]>();
  for (const row of targets) {
    const list = byPath.get(row.path);
    if (list === undefined) byPath.set(row.path, [row]);
    else list.push(row);
  }
  const files = new Map([...byPath].map(([path, rows]) => [path, new KeyIndex(rows)]));
  const wanted = new Map<number, { row: LimitTarget; maxLength: number; where: string }>();
  const warnings: string[] = [];
  for (const limit of limits) {
    const where = `${limit.file} › ${limit.key}`;
    const rows = files.get(limit.file)?.find(parseKeySelector(limit.key)) ?? [];
    if (rows.length === 0) {
      warnings.push(`The limit for ${where} names a string the server doesn't have`);
      continue;
    }
    if (rows.length > 1) {
      warnings.push(
        `The limit for ${where} names ${rows.length} strings, so it was left out; ${AMBIGUOUS_HINT}`,
      );
      continue;
    }
    const previous = wanted.get(rows[0].id);
    if (previous !== undefined && previous.maxLength !== limit.maxLength) {
      warnings.push(
        `The limits for ${previous.where} and ${where} name the same string; the last one (${limit.maxLength}) applies`,
      );
    }
    wanted.set(rows[0].id, { row: rows[0], maxLength: limit.maxLength, where });
  }
  const changes = new Map<number, number | null>();
  for (const { row, maxLength } of wanted.values()) {
    if (row.max_length === maxLength && row.max_length_locked === 1) continue;
    changes.set(row.id, maxLength);
  }
  for (const id of lockedUploadedIds) if (!wanted.has(id)) changes.set(id, null);
  return {
    changes: [...changes].map(([id, maxLength]) => ({ id, maxLength })),
    statements: [...changes].map(([id, maxLength]) => ({
      sql: "UPDATE strings SET max_length = ?, max_length_locked = ?, updated_at = ? WHERE id = ?",
      params: [maxLength, maxLength === null ? 0 : 1, at, id],
    })),
    recheck: [...changes.keys()],
    warnings,
  };
}
