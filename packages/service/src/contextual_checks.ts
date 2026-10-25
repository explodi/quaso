// SPDX-License-Identifier: MIT
/** File-wide warnings refresh after source or translation writes without changing human text. */
import {
  checkDuplicateTranslations,
  checkTranslationConsistency,
  type CheckResult,
  type EntryKind,
  type TextValue,
} from "@quaso/core";
import { fromJson, getRevision } from "./db.ts";
import type { Sql, SqlRow, Statement, SyncSql } from "./ports.ts";

const COLUMNS = `t.string_id, t.language, t.value, t.revision, t.extra_checks,
  s.file_id, f.path, s.display_key, s.kind, s.source, s.source_hash, s.description`;
const TRANSLATABLE = `s.active = 1 AND f.active = 1 AND s.kind IN ('text', 'plural', 'ordinal')`;

const SNAPSHOT = `SELECT ${COLUMNS} FROM translations t
  JOIN strings s ON s.id = t.string_id JOIN files f ON f.id = s.file_id
  WHERE ${TRANSLATABLE}`;

/**
 * The translations whose checks a change can affect: every one in a changed string's file and
 * language (duplicates compare within those), and every one in its language with the same
 * English (consistency compares those). `by_file` and `by_source` say which group is whole.
 */
const CHANGED_SCOPE = `WITH scope (language, string_id, by_file, by_source) AS (
    SELECT json_extract(j.value, '$[0]'), s.id, 1, 0 FROM json_each(?) j
      JOIN strings s ON s.file_id = json_extract(j.value, '$[1]')
    UNION ALL
    SELECT json_extract(j.value, '$[0]'), s.id, 0, 1 FROM json_each(?) j
      JOIN strings s ON s.source_hash = json_extract(j.value, '$[1]')
  )
  SELECT ${COLUMNS}, MAX(scope.by_file) AS by_file, MAX(scope.by_source) AS by_source
  FROM scope JOIN translations t ON t.string_id = scope.string_id AND t.language = scope.language
  JOIN strings s ON s.id = t.string_id JOIN files f ON f.id = s.file_id
  WHERE ${TRANSLATABLE}
  GROUP BY t.string_id, t.language`;

const REVISION: Statement = {
  sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'",
};
/** The `meta` key of the newest history row whose change the stored checks reflect. */
export const CHECKS_CHECKPOINT = "checks_history";
const LATEST_HISTORY: Statement = { sql: "SELECT COALESCE(MAX(id), 0) AS id FROM history" };

const SOURCE_WRITE = /(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:strings|files)\b/i;
const TRANSLATION_WRITE = /(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+translations\b/i;

/**
 * Rows of a full snapshot recheck both file-wide checks; rows of a changed scope recheck only
 * those whose group the scope holds whole, and keep the other as stored.
 */
function updates(rows: SqlRow[], revision: number): Statement[] {
  const entries = rows.map((row) => ({
    id: Number(row.string_id),
    fileId: Number(row.file_id),
    file: String(row.path),
    language: String(row.language),
    key: String(row.display_key),
    kind: row.kind as EntryKind,
    source: fromJson<TextValue>(row.source),
    translation: fromJson<TextValue>(row.value),
  }));
  const duplicates = checkDuplicateTranslations(entries);
  const consistency = checkTranslationConsistency(entries);
  const statements: Statement[] = [];
  for (const row of rows) {
    const key = JSON.stringify([Number(row.string_id), row.language]);
    const stored = fromJson<CheckResult[]>(row.extra_checks);
    const recheckDuplicates = row.by_file === undefined || Number(row.by_file) === 1;
    const recheckConsistency = row.by_source === undefined || Number(row.by_source) === 1;
    const other = stored.filter((check) => {
      const fileCheck = check.check === "duplicate_translation" || check.check === "consistency";
      const staleMeaning =
        check.check === "meaning" &&
        (check.sourceHash !== row.source_hash ||
          (check.sourceDescription ?? "") !== row.description);
      return !fileCheck && !staleMeaning;
    });
    const storedDuplicates = stored.filter((check) => check.check === "duplicate_translation");
    const storedConsistency = stored.filter((check) => check.check === "consistency");
    const checks = JSON.stringify([
      ...other,
      ...(recheckDuplicates ? (duplicates.get(key) ?? []) : storedDuplicates),
      ...(recheckConsistency ? (consistency.get(key) ?? []) : storedConsistency),
    ]);
    if (checks === row.extra_checks) continue;
    statements.push({
      sql: `UPDATE translations SET extra_checks = ? WHERE string_id = ? AND language = ? AND revision = ?
        AND EXISTS (SELECT 1 FROM strings WHERE id = ? AND source_hash = ?)
        AND (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision') = ?`,
      params: [
        checks,
        row.string_id,
        row.language,
        row.revision,
        row.string_id,
        row.source_hash,
        revision,
      ],
    });
  }
  return statements;
}

/**
 * Applies the updates and moves the checkpoint, both only while the revision is still the one
 * they were decided at. Changed checks raise the revision, so a value cached under the
 * revision is never stale; the raise goes last, so the statements before it still see it.
 */
async function apply(sql: Sql, revision: number, statements: Statement[], history: number) {
  const checkpoint: Statement = {
    sql: `INSERT INTO meta (key, value) SELECT ?, ?
      WHERE (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision') = ?
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    params: [CHECKS_CHECKPOINT, String(history), revision],
  };
  const raise: Statement = {
    sql: "UPDATE meta SET value = CAST(? + 1 AS TEXT) WHERE key = 'revision' AND CAST(value AS INTEGER) = ?",
    params: [revision, revision],
  };
  const raises = statements.length > 0 ? [raise] : [];
  await sql.migrate([...statements, checkpoint, ...raises]);
}

export function refreshContextualChecksSync(sql: SyncSql): void {
  for (const statement of updates(sql.query(SNAPSHOT), getRevision(sql)))
    sql.run(statement.sql, ...(statement.params ?? []));
}

/** Checks every translation again: after a source change or a restore, and at startup. */
export async function refreshContextualChecks(sql: Sql): Promise<void> {
  const [revision, latest, rows] = await sql.read([REVISION, LATEST_HISTORY, { sql: SNAPSHOT }]);
  const read = Number(revision[0]?.revision ?? 0);
  await apply(sql, read, updates(rows, read), Number(latest[0].id));
}

/**
 * Checks again only the translations that changes since the checkpoint can affect: a saved
 * translation reads its file and the peers of its English, not the whole project. Every
 * translation change writes history in the same commit, which is what makes that list whole.
 */
export async function refreshChangedChecks(sql: Sql): Promise<void> {
  const [stored] = await sql.read([
    {
      sql: "SELECT CAST(value AS INTEGER) AS id FROM meta WHERE key = ?",
      params: [CHECKS_CHECKPOINT],
    },
  ]);
  if (stored.length === 0) return refreshContextualChecks(sql);
  const since = Number(stored[0].id);
  const [revision, latest, changes] = await sql.read([
    REVISION,
    LATEST_HISTORY,
    {
      sql: `SELECT DISTINCT h.language, s.file_id, s.source_hash FROM history h
        JOIN strings s ON s.id = h.string_id WHERE h.id > ? AND h.language IS NOT NULL`,
      params: [since],
    },
  ]);
  const read = Number(revision[0]?.revision ?? 0);
  const history = Number(latest[0].id);
  if (history === since) return;
  let rows: SqlRow[] = [];
  if (changes.length > 0) {
    const files = changes.map((change) => [change.language, change.file_id]);
    const sources = changes.map((change) => [change.language, change.source_hash]);
    [rows] = await sql.read([
      { sql: CHANGED_SCOPE, params: [JSON.stringify(files), JSON.stringify(sources)] },
    ]);
  }
  await apply(sql, read, updates(rows, read), history);
}

/** Source writes check every translation again; translation writes only what they can affect. */
export function withContextualChecks(sql: Sql): Sql {
  return {
    ...sql,
    async commit(revision, statements) {
      const next = await sql.commit(revision, statements);
      const writesSource = statements.some((statement) => SOURCE_WRITE.test(statement.sql));
      const writesTranslations = statements.some((statement) =>
        TRANSLATION_WRITE.test(statement.sql),
      );
      if (writesSource) await refreshContextualChecks(sql);
      else if (writesTranslations) await refreshChangedChecks(sql);
      return next;
    },
  };
}
