// SPDX-License-Identifier: MIT
/** Exact source/kind matches reuse current, checked values; proofread matches come first. */
import type { Facts } from "../facts.ts";
import type { SqlRow, Statement } from "../ports.ts";
import { fromJson } from "../db.ts";
import { checkValue } from "../translations.ts";
import type { TextValue } from "@quaso/core";
import type { Batch } from "./work.ts";
import type { BatchSuccess } from "./write.ts";

export function memoryRead(batch: Batch): Statement {
  return {
    sql: `SELECT s.id, f.path, s.display_key, s.kind, s.source_hash, t.value FROM strings s
      JOIN files f ON f.id = s.file_id JOIN translations t ON t.string_id = s.id AND t.language = ?
      WHERE s.active = 1 AND f.active = 1 AND t.source_hash = s.source_hash AND t.qa_errors = 0
        AND s.source_hash IN (SELECT value FROM json_each(?)) ORDER BY t.colour = 'blue' DESC, s.id`,
    params: [batch.language, JSON.stringify(batch.items.map((item) => item.sourceHash))],
  };
}

export function memoryMatches(
  batch: Batch,
  rows: SqlRow[],
  facts: Facts,
): Map<number, BatchSuccess> {
  const matches = new Map<number, BatchSuccess>();
  for (const item of batch.items) {
    if (item.action === "propose") continue;
    const candidates = rows.filter(
      (row) =>
        row.source_hash === item.sourceHash && row.kind === item.kind && row.id !== item.stringId,
    );
    for (const row of candidates) {
      const value = fromJson<TextValue>(row.value);
      const checks = checkValue(
        facts,
        { kind: item.kind, source: JSON.stringify(item.english), max_length: item.maxLength },
        item.language,
        value,
      );
      if (checks.some((check) => check.severity === "error")) continue;
      matches.set(item.stringId, {
        value,
        model: "Translation memory",
        requestId: 0,
        reusedFrom: { id: Number(row.id), file: String(row.path), key: String(row.display_key) },
      });
      break;
    }
  }
  return matches;
}
