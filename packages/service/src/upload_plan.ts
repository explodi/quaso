// SPDX-License-Identifier: MIT
import {
  canonicalLanguageTag,
  hasPluralRules,
  type UploadFileResult,
  type UploadRequest,
  type UploadResult,
} from "@quaso/core";
import type { Author } from "./actors.ts";
import { forEachChunk, fromJsonOrNull, placeholders, toJson } from "./db.ts";
import { isTranslatableKind } from "./entries.ts";
import { badRequest } from "./errors.ts";
import { KeyIndex, parseKeySelector } from "./keys.ts";
import type { CheckFacts } from "./facts.ts";
import type { Statement } from "./ports.ts";
import { planRenameMove, resolveRenameRows } from "./rename.ts";
import { diffSourceStrings } from "./source_diff.ts";
import { historyParams, type HistoryRecord, planQa } from "./translations.ts";
import { planUploadLimits } from "./upload_limits.ts";
import { readUploadFiles } from "./upload_parse.ts";
import { type RenameCandidate, suggestUploadRenames } from "./upload_renames.ts";
import type { UploadSnapshot, UploadSourceRow } from "./upload_snapshot.ts";

type Touched = RenameCandidate & { key: string };

/** Decide the entire upload without I/O; the revision guard protects allocated IDs. */
export function planUpload(
  snapshot: UploadSnapshot,
  request: UploadRequest,
  author: Author,
  revision: number,
  at: number,
  llmAvailable: boolean,
): { statements: Statement[]; result: UploadResult } {
  const parsed = readUploadFiles(request, snapshot.settings);
  const statements: Statement[] = [];
  const history: HistoryRecord[] = [];
  const files = new Map(snapshot.files.map((row) => [row.path, { ...row }]));
  const strings = new Map(snapshot.strings.map((row) => [row.id, { ...row }]));
  const byFile = new Map<number, UploadSourceRow[]>();
  for (const row of strings.values()) {
    const rows = byFile.get(row.file_id);
    if (rows === undefined) byFile.set(row.file_id, [row]);
    else rows.push(row);
  }
  let translations = snapshot.translations.map((row) => ({ ...row }));
  const suggestions = snapshot.suggestions.map((row) => ({ ...row }));
  const humanHistory = snapshot.humanHistory.map((row) => ({ ...row }));
  const previousRenames = snapshot.renames.map((row) => ({ ...row }));
  const nextIds = { ...snapshot.nextIds };
  let settings = snapshot.settings;
  let languages = [...snapshot.languages];
  const added: Touched[] = [];
  const changed: Touched[] = [];
  const removed: Touched[] = [];
  const restored: Touched[] = [];
  const recheck = new Set<number>();
  const uploadedIds = new Set<number>();
  const result: UploadResult = {
    dryRun: request.dryRun === true,
    uploadId: null,
    files: [],
    added: [],
    changed: [],
    removed: [],
    restored: [],
    renamed: [],
    renameSuggestions: [],
    hiddenFiles: [],
    languagesAdded: [],
    warnings: [],
    job: null,
    revision,
  };
  let moved = 0;
  const touch = (row: UploadSourceRow): Touched => ({
    id: row.id,
    fileId: row.file_id,
    file: row.path,
    key: row.display_key,
    position: row.position,
    kind: row.kind,
    sourceHash: row.source_hash,
  });
  const sourceEvent = (
    row: UploadSourceRow,
    event: HistoryRecord["event"],
    before: string | null,
    after: string | null,
  ) => {
    history.push({
      stringId: row.id,
      language: null,
      event,
      before: before === null ? null : [before, null],
      after: after === null ? null : [after, null],
      actor: author,
      at,
    });
  };
  if (request.sourceLanguage !== undefined) {
    const tag = canonicalLanguageTag(request.sourceLanguage) ?? request.sourceLanguage;
    if (tag !== settings.sourceLanguage) {
      if (snapshot.hasStrings)
        throw badRequest(
          `The source language is ${settings.sourceLanguage} on the server, but the upload says ${tag}.`,
        );
      settings = { ...settings, sourceLanguage: tag };
      statements.push(
        {
          sql: "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
          params: [toJson(settings)],
        },
        { sql: "DELETE FROM languages WHERE tag = ?", params: [tag] },
      );
      languages = languages.filter((language) => language.tag !== tag);
    }
  }
  const knownLanguages = new Set(languages.map((language) => language.tag));
  for (const requested of request.languages ?? []) {
    const tag = canonicalLanguageTag(requested) ?? requested;
    if (tag === settings.sourceLanguage || knownLanguages.has(tag)) continue;
    knownLanguages.add(tag);
    languages.push({ tag, instructions: "", pluralOverride: undefined, createdAt: at });
    result.languagesAdded.push(tag);
    statements.push({
      sql: "INSERT INTO languages (tag, created_at) VALUES (?, ?)",
      params: [tag, at],
    });
    if (!hasPluralRules(tag))
      result.warnings.push(
        `The server's runtime has no plural rules for ${tag}; set a plural override for it in the settings`,
      );
  }
  for (const file of parsed) {
    let row = files.get(file.path);
    let status: UploadFileResult["status"] = "unchanged";
    const metadataChanged = row?.format !== file.format || row?.repo_path !== file.repoPath;
    if (row === undefined) {
      row = {
        id: nextIds.file++,
        path: file.path,
        repo_path: file.repoPath,
        format: file.format,
        active: 1,
      };
      files.set(file.path, row);
      statements.push({
        sql: "INSERT INTO files (id, path, repo_path, format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [row.id, row.path, row.repo_path, row.format, at, at],
      });
      status = "new";
    } else if (row.active === 0 || metadataChanged) {
      status = row.active === 0 ? "restored" : "updated";
      statements.push({
        sql: "UPDATE files SET active = 1, repo_path = ?, format = ?, updated_at = ? WHERE id = ?",
        params: [file.repoPath, file.format, at, row.id],
      });
      row.active = 1;
      row.format = file.format;
      row.repo_path = file.repoPath;
    }
    uploadedIds.add(row.id);
    const diff = diffSourceStrings(file.entries, byFile.get(row.id) ?? []);
    const inserted: { row: UploadSourceRow; searchText: string }[] = [];
    for (const change of diff.changes) {
      const { entry, position } = change;
      if (change.type === "unchanged") continue;
      if (change.type === "added") {
        const source: UploadSourceRow = {
          id: nextIds.string++,
          file_id: row.id,
          path: row.path,
          file_active: 1,
          key: entry.key,
          key_path: entry.keyPath,
          display_key: entry.displayKey,
          kind: entry.kind,
          source: entry.source,
          source_hash: entry.sourceHash,
          words: entry.words,
          position,
          active: 1,
          max_length: null,
          max_length_locked: 0,
        };
        strings.set(source.id, source);
        inserted.push({ row: source, searchText: entry.searchText });
        added.push(touch(source));
        sourceEvent(source, "source_added", null, source.source);
        continue;
      }
      const source = strings.get(change.previous.id)!;
      if (change.type === "moved") {
        statements.push({
          sql: "UPDATE strings SET position = ?, updated_at = ? WHERE id = ?",
          params: [position, at, source.id],
        });
        source.position = position;
        continue;
      }
      const before = source.source;
      Object.assign(source, {
        kind: entry.kind,
        source: entry.source,
        source_hash: entry.sourceHash,
        words: entry.words,
        position,
        active: 1,
      });
      statements.push({
        sql: `UPDATE strings SET kind = ?, source = ?, source_hash = ?, words = ?, search_text = ?,
        position = ?, active = 1, updated_at = ? WHERE id = ?`,
        params: [
          entry.kind,
          entry.source,
          entry.sourceHash,
          entry.words,
          entry.searchText,
          position,
          at,
          source.id,
        ],
      });
      if (change.type === "restored") {
        restored.push(touch(source));
        sourceEvent(source, "source_restored", change.sourceChanged ? before : null, source.source);
        if (change.sourceChanged) recheck.add(source.id);
      } else {
        changed.push(touch(source));
        sourceEvent(source, "source_changed", before, source.source);
        recheck.add(source.id);
      }
    }
    forEachChunk(inserted, 13, (chunk) => {
      statements.push({
        sql: `INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source,
        source_hash, words, search_text, position, created_at, updated_at)
        VALUES ${chunk.map(() => `(${placeholders(13)})`).join(", ")}`,
        params: chunk.flatMap(({ row: source, searchText }) => [
          source.id,
          source.file_id,
          source.key,
          source.key_path,
          source.display_key,
          source.kind,
          source.source,
          source.source_hash,
          source.words,
          searchText,
          source.position,
          at,
          at,
        ]),
      });
    });
    for (const old of diff.removed) {
      const source = strings.get(old.id)!;
      source.active = 0;
      removed.push(touch(source));
      sourceEvent(source, "source_removed", source.source, null);
    }
    if (diff.removed.length > 0)
      statements.push({
        sql: `UPDATE strings SET active = 0, updated_at = ?
      WHERE id IN (SELECT value FROM json_each(?))`,
        params: [at, toJson(diff.removed.map((old) => old.id))],
      });
    moved += diff.counts.moved;
    const touched =
      diff.counts.added +
      diff.counts.changed +
      diff.counts.removed +
      diff.counts.restored +
      diff.counts.moved;
    if (status === "unchanged" && touched > 0) status = "updated";
    if (status !== "unchanged") {
      statements.push({
        sql: "UPDATE files SET source_updated_at = ?, source_revision = ? WHERE id = ?",
        params: [at, revision + 1, row.id],
      });
    }
    result.files.push({ path: file.path, status, ...diff.counts });
  }
  if (!request.partial) {
    for (const file of files.values()) {
      if (file.active !== 1 || uploadedIds.has(file.id)) continue;
      file.active = 0;
      statements.push({
        sql: "UPDATE files SET active = 0, updated_at = ? WHERE id = ?",
        params: [at, file.id],
      });
      result.hiddenFiles.push(file.path);
      result.files.push({
        path: file.path,
        status: "hidden",
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        moved: 0,
        unchanged: 0,
      });
    }
  }
  const activeFileIds = new Set(
    [...files.values()].filter((file) => file.active === 1).map((file) => file.id),
  );
  const sourceRows = [...strings.values()];
  const limitTargets = sourceRows.filter(
    (row) => activeFileIds.has(row.file_id) && row.active === 1 && isTranslatableKind(row.kind),
  );
  for (const file of parsed) {
    const index = new KeyIndex(limitTargets.filter((row) => row.path === file.path));
    for (const item of file.descriptions ?? []) {
      const targets = index.find(parseKeySelector(item.key));
      if (targets.length !== 1) {
        result.warnings.push(
          `${file.path} description ${item.key}: ${targets.length === 0 ? "no source string" : "ambiguous source key"}.`,
        );
        continue;
      }
      const row = targets[0];
      if ((row.description ?? "") === item.description) continue;
      row.description = item.description;
      statements.push({
        sql: "UPDATE strings SET description = ?, updated_at = ? WHERE id = ?",
        params: [item.description, at, row.id],
      });
    }
  }
  const locked = sourceRows
    .filter((row) => uploadedIds.has(row.file_id) && row.max_length_locked === 1)
    .map((row) => row.id);
  const limitPlan = planUploadLimits(request.limits ?? [], limitTargets, locked, at);
  statements.push(...limitPlan.statements);
  result.warnings.push(...limitPlan.warnings);
  for (const change of limitPlan.changes) {
    const row = strings.get(change.id)!;
    row.max_length = change.maxLength;
    row.max_length_locked = change.maxLength === null ? 0 : 1;
    recheck.add(change.id);
  }
  const renamedIds = new Set<number>();
  const renameRows = sourceRows.filter(
    (row) => activeFileIds.has(row.file_id) && isTranslatableKind(row.kind),
  );
  for (const rename of request.renames ?? []) {
    const ends = resolveRenameRows(renameRows, rename, " after the upload");
    const { from, to } = ends;
    renamedIds.add(from.id);
    renamedIds.add(to.id);
    const hasWork =
      translations.some((row) => row.string_id === from.id) ||
      suggestions.some((row) => row.string_id === from.id);
    const alreadyMoved = previousRenames.some(
      (row) =>
        row.string_id === to.id &&
        fromJsonOrNull<{ fromStringId?: number }>(row.detail)?.fromStringId === from.id,
    );
    if (!hasWork && alreadyMoved) continue;
    const fromLanguages = new Set(
      translations.filter((row) => row.string_id === from.id).map((row) => row.language),
    );
    const clashes = translations
      .filter((row) => row.string_id === to.id && fromLanguages.has(row.language))
      .map((row) => ({
        language: row.language,
        value: row.value,
        colour: row.colour,
        author_type: row.author_type,
        people: humanHistory
          .filter((old) => old.string_id === to.id && old.language === row.language)
          .reduce((sum, old) => sum + old.people, 0),
      }));
    const move = planRenameMove(ends, rename, author, at, clashes);
    statements.push(...move.statements);
    history.push(move.history);
    const replaced = new Set(clashes.map((row) => row.language));
    translations = translations.filter(
      (row) => row.string_id !== to.id || !replaced.has(row.language),
    );
    if (author.type !== "llm")
      for (const clash of clashes)
        humanHistory.push({ string_id: to.id, language: clash.language, people: 1 });
    for (const row of translations) if (row.string_id === from.id) row.string_id = to.id;
    for (const row of suggestions) if (row.string_id === from.id) row.string_id = to.id;
    for (const row of humanHistory) if (row.string_id === from.id) row.string_id = to.id;
    for (const row of previousRenames) if (row.string_id === from.id) row.string_id = to.id;
    result.renamed.push({ file: from.path, from: rename.from, to: rename.to });
    recheck.add(to.id);
  }
  result.renameSuggestions = suggestUploadRenames(
    removed.filter((row) => !renamedIds.has(row.id)),
    added.filter((row) => !renamedIds.has(row.id)),
    new Set(translations.map((row) => row.string_id)),
    sourceRows.filter((row) => isTranslatableKind(row.kind)),
  );
  const facts: CheckFacts = {
    sourceLanguage: settings.sourceLanguage,
    syntax: settings.syntax,
    languages: new Map(languages.map((language) => [language.tag, language])),
    glossary: snapshot.glossary.map((term) => ({
      ...term,
      caseSensitive: term.case_sensitive === 1,
    })),
  };
  const qa = translations
    .filter(
      (row) => recheck.has(row.string_id) && isTranslatableKind(strings.get(row.string_id)!.kind),
    )
    .map((row) => {
      const source = strings.get(row.string_id)!;
      return { ...row, kind: source.kind, source: source.source, max_length: source.max_length };
    });
  statements.push(...planQa(qa, facts));
  const refs = (items: Touched[]) =>
    [...items]
      .sort((a, b) => compare(a.file, b.file) || a.position - b.position)
      .map((row) => ({ file: row.file, key: row.key }));
  result.added = refs(added);
  result.changed = refs(changed);
  result.removed = refs(removed);
  result.restored = refs(restored);
  result.files.sort((a, b) => compare(a.path, b.path));
  result.hiddenFiles.sort(compare);
  if (request.dryRun || statements.length === 0) return { statements: [], result };
  result.revision = revision + 1;
  result.uploadId = nextIds.upload;
  statements.push({
    sql: `INSERT INTO uploads (id, actor_type, actor_id, added, changed, removed, restored, moved, files, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      result.uploadId,
      author.type,
      author.id,
      added.length,
      changed.length,
      removed.length,
      restored.length,
      moved,
      toJson(result.files),
      at,
    ],
  });
  forEachChunk(history, 12, (chunk) =>
    statements.push({
      sql: `INSERT INTO history (string_id, language, event, before_value, after_value,
      before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at)
      VALUES ${chunk.map(() => `(${placeholders(12)})`).join(", ")}`,
      params: chunk.flatMap((record) =>
        historyParams({ ...record, detail: { ...record.detail, upload: result.uploadId } }),
      ),
    }),
  );
  const parts: string[] = [];
  for (const [count, label] of [
    [added.length, "added"],
    [changed.length, "changed"],
    [removed.length, "removed"],
    [restored.length, "restored"],
    [result.renamed.length, "renamed"],
  ] as const) {
    if (count > 0) parts.push(`${count} ${label}`);
  }
  if (result.hiddenFiles.length > 0) parts.push(`${result.hiddenFiles.length} files hidden`);
  if (result.languagesAdded.length > 0)
    parts.push(`languages added: ${result.languagesAdded.join(", ")}`);
  const summary =
    parts.length === 0 ? "Upload: no changes to strings" : `Upload: ${parts.join(", ")}`;
  const detail = {
    uploadId: result.uploadId,
    added: added.length,
    changed: changed.length,
    removed: removed.length,
    restored: restored.length,
    moved,
    files: result.files.map((file) => ({ path: file.path, status: file.status })),
    renamed: result.renamed,
    renameSuggestions: result.renameSuggestions,
    hiddenFiles: result.hiddenFiles,
    languagesAdded: result.languagesAdded,
  };
  statements.push({
    sql: `INSERT INTO activity (type, actor_type, actor_id, actor_label, summary, detail, created_at)
    VALUES ('upload', ?, ?, ?, ?, ?, ?)`,
    params: [author.type, author.id, author.label, summary, toJson(detail), at],
  });
  if (llmAvailable && settings.llm.autoTranslate) {
    const touched = [...added, ...changed, ...restored].map((row) => row.id);
    const ids = new Set(touched);
    const current = new Map(
      translations.map((row) => [toJson([row.string_id, row.language]), row]),
    );
    const pending = new Set(
      suggestions
        .filter((row) => row.kind === "llm" && row.status === "pending")
        .map((row) => toJson([row.string_id, row.language, row.source_hash])),
    );
    let total = 0;
    for (const id of ids) {
      const source = strings.get(id)!;
      if (
        source.active !== 1 ||
        !activeFileIds.has(source.file_id) ||
        !isTranslatableKind(source.kind)
      )
        continue;
      for (const language of languages) {
        const translation = current.get(toJson([id, language.tag]));
        if (translation === undefined) {
          total++;
          continue;
        }
        if (translation.source_hash === source.source_hash) continue;
        const update = translation.colour === "green" && settings.llm.updateOutdated;
        const propose =
          translation.colour === "blue" &&
          settings.llm.proposeForProofread &&
          !pending.has(toJson([id, language.tag, source.source_hash]));
        if (update || propose) total++;
      }
    }
    if (total > 0) {
      result.job = { id: nextIds.job };
      const scope = {
        strings: [...ids].sort((a, b) => a - b),
        outdated: settings.llm.updateOutdated || settings.llm.proposeForProofread,
      };
      statements.push({
        sql: `INSERT INTO jobs (id, status, priority, source, scope, actor_type, actor_id, actor_label, total, created_at, updated_at)
        VALUES (?, 'queued', 1, 'upload', ?, ?, ?, ?, ?, ?, ?)`,
        params: [nextIds.job, toJson(scope), author.type, author.id, author.label, total, at, at],
      });
    }
  }
  return { statements, result };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
