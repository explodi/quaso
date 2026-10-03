// SPDX-License-Identifier: MIT
/** Canonical, deduplicated language requests; each person can vote once per open request. */
import {
  canonicalLanguageTag,
  SUPPORTED_LANGUAGES,
  type CreateLanguageRequestRequest,
  languageName,
  type LanguageRequestInfo,
  type LanguageRequestsResult,
  type ReviewLanguageRequestRequest,
} from "@quaso/core";
import { ActorDirectory, type ActorRows } from "./actors.ts";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { bumpRevision } from "./db.ts";
import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { findLanguage, toLanguage, type LanguageRow } from "./languages.ts";
import { requirePermission, permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import { silentLogger, type Sql, type Statement } from "./ports.ts";
import { loadSettings, settingsFromData } from "./settings.ts";
import { addProjectLanguage } from "./settings_api.ts";
import { planQa, type QaRow } from "./translations.ts";
import type { SettingsWriteOptions } from "./settings_writes.ts";
import { withRetries } from "./write.ts";

const supportedTags = new Set(SUPPORTED_LANGUAGES.map((language) => language.tag));

type Row = {
  id: number;
  tag: string;
  message: string;
  status: LanguageRequestInfo["status"];
  requested_by: number | null;
  votes: number;
  voted: number;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: number | null;
};

const REQUEST_SQL = `SELECT r.*, EXISTS (SELECT 1 FROM language_request_votes v WHERE v.request_id = r.id AND v.user_id = ?) AS voted
  FROM language_requests r WHERE (? IS NULL OR r.id = ?) ORDER BY votes DESC, r.id`;

export function listLanguageRequests(ctx: Context, actor: Actor): LanguageRequestsResult {
  if (!loadSettings(ctx).languageRequestsEnabled) return { requests: [] };
  return { requests: read(ctx, actor).filter((row) => row.status === "pending") };
}

/** Votes, attribution and caller permissions are resolved in one read batch. */
export async function listLanguageRequestsAsync(
  sql: Sql,
  actor: Actor,
): Promise<LanguageRequestsResult> {
  const requests: Statement = {
    sql: `SELECT * FROM (${REQUEST_SQL}) WHERE status = 'pending' ORDER BY votes DESC, id`,
    params: [actor.type === "user" ? actor.userId : null, null, null],
  };
  const [rows, users, stored, ...permissionRows] = await sql.read([
    requests,
    {
      sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN
      (SELECT requested_by FROM (${requests.sql}) UNION ALL SELECT reviewed_by FROM (${requests.sql}))`,
      params: [...requests.params!, ...requests.params!],
    },
    {
      sql: "SELECT json_extract(data, '$.languageRequestsEnabled') AS enabled FROM settings WHERE id = 1",
    },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("read");
  if (stored[0]?.enabled !== 1) return { requests: [] };
  const actors = new ActorDirectory({ users: users as ActorRows["users"], tokens: [] });
  return { requests: requestInfos(rows as Row[], actors) };
}

export function requestLanguage(
  ctx: Context,
  actor: Actor,
  request: CreateLanguageRequestRequest,
): LanguageRequestInfo {
  requirePermission(ctx, actor, "requestLanguage");
  const settings = loadSettings(ctx);
  if (!settings.languageRequestsEnabled) throw forbidden("Language requests are turned off.");
  const tag = canonicalLanguageTag(request.tag)!;
  if (!supportedTags.has(tag)) throw badRequest("Choose a supported language from the list.");
  if (tag === settings.sourceLanguage) throw badRequest("That is the source language.");
  if (findLanguage(ctx.sql, tag)) throw conflict(`The project already has ${tag}.`);
  let id = ctx.sql.query<{ id: number }>(
    "SELECT id FROM language_requests WHERE tag = ? AND status = 'pending'",
    tag,
  )[0]?.id;
  let changed = false;
  if (id === undefined) {
    id = ctx.sql.query<{ id: number }>(
      `INSERT INTO language_requests (tag, message, status, requested_by, created_at)
      VALUES (?, ?, 'pending', ?, ?) RETURNING id`,
      tag,
      request.message?.trim() ?? "",
      actor.type === "user" ? actor.userId : null,
      ctx.clock(),
    )[0].id;
    changed = true;
  }
  if (actor.type === "user") {
    const inserted = ctx.sql.query(
      `INSERT INTO language_request_votes (request_id, user_id) VALUES (?, ?)
      ON CONFLICT DO NOTHING RETURNING request_id`,
      id,
      actor.userId,
    );
    if (inserted.length) {
      ctx.sql.run("UPDATE language_requests SET votes = votes + 1 WHERE id = ?", id);
      changed = true;
    }
  }
  if (changed) bumpRevision(ctx.sql);
  return read(ctx, actor, id)[0];
}

export function reviewLanguageRequest(
  ctx: Context,
  actor: Actor,
  id: number,
  request: ReviewLanguageRequestRequest,
): LanguageRequestInfo {
  requirePermission(ctx, actor, "settings");
  const current = read(ctx, actor, id)[0];
  if (!current) throw notFound(`Language request ${id}`);
  if (current.status !== "pending") {
    throw conflict("That language request has already been reviewed.");
  }
  if (request.action === "approve" && !findLanguage(ctx.sql, current.tag)) {
    addProjectLanguage(ctx, actor, current.tag);
  }
  ctx.sql.run(
    "UPDATE language_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?",
    request.action === "approve" ? "approved" : "rejected",
    ctx.clock(),
    actor.type === "user" ? actor.userId : null,
    id,
  );
  bumpRevision(ctx.sql);
  return read(ctx, actor, id)[0];
}

function read(ctx: Context, actor: Actor, id?: number): LanguageRequestInfo[] {
  const rows = ctx.sql.query<Row>(
    REQUEST_SQL,
    actor.type === "user" ? actor.userId : null,
    id ?? null,
    id ?? null,
  );
  const actors = new ActorDirectory(
    ctx.sql,
    [],
    rows.flatMap((r) => [r.requested_by, r.reviewed_by]),
  );
  return requestInfos(rows, actors);
}

const REVISION: Statement = {
  sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
};

export async function requestLanguageAsync(
  sql: Sql,
  actor: Actor,
  request: CreateLanguageRequestRequest,
  options: SettingsWriteOptions,
): Promise<LanguageRequestInfo> {
  const tag = canonicalLanguageTag(request.tag);
  const userId = actor.type === "user" ? actor.userId : null;
  const selection: Statement = {
    sql: `SELECT * FROM (${REQUEST_SQL}) WHERE tag = ? AND status = 'pending'`,
    params: [userId, null, null, tag],
  };
  return withRetries(
    sql,
    async () => {
      const [revision, requests, ids, stored, languages, users, ...permissionRows] = await sql.read(
        [
          REVISION,
          selection,
          { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM language_requests" },
          { sql: "SELECT data FROM settings WHERE id = 1" },
          { sql: "SELECT tag FROM languages WHERE tag = ?", params: [tag] },
          {
            sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN (SELECT requested_by FROM (${selection.sql}) UNION ALL SELECT ?)`,
            params: [...selection.params!, userId],
          },
          ...permissionReadStatements(actor),
        ],
      );
      return {
        revision: Number(revision[0].revision),
        state: {
          current: requests[0] as Row | undefined,
          id: Number(ids[0].id),
          stored: (stored[0]?.data as string | undefined) ?? null,
          exists: languages.length > 0,
          actors: new ActorDirectory({ users: users as ActorRows["users"], tokens: [] }),
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("requestLanguage");
      if (tag === null) throw badRequest(`${request.tag} isn't a language tag.`);
      if (!supportedTags.has(tag)) throw badRequest("Choose a supported language from the list.");
      const settings = settingsFromData(state.stored, options.model);
      if (!settings.languageRequestsEnabled) throw forbidden("Language requests are turned off.");
      if (tag === settings.sourceLanguage) throw badRequest("That is the source language.");
      if (state.exists) throw conflict(`The project already has ${tag}.`);
      const row: Row = state.current ?? {
        id: state.id,
        tag,
        message: request.message?.trim() ?? "",
        status: "pending",
        requested_by: userId,
        votes: 0,
        voted: 0,
        created_at: options.now,
        reviewed_at: null,
        reviewed_by: null,
      };
      const voting = userId !== null && row.voted === 0;
      const updated = {
        ...row,
        votes: row.votes + (voting ? 1 : 0),
        voted: voting ? 1 : row.voted,
      };
      const statements: Statement[] = [];
      if (!state.current)
        statements.push({
          sql: "INSERT INTO language_requests (id, tag, message, status, requested_by, votes, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
          params: [row.id, tag, row.message, userId, updated.votes, options.now],
        });
      if (voting) {
        statements.push({
          sql: "INSERT INTO language_request_votes (request_id, user_id) VALUES (?, ?)",
          params: [row.id, userId],
        });
        if (state.current)
          statements.push({
            sql: "UPDATE language_requests SET votes = ? WHERE id = ?",
            params: [updated.votes, row.id],
          });
      }
      return { statements, result: requestInfos([updated], state.actors)[0] };
    },
  );
}

export async function reviewLanguageRequestAsync(
  sql: Sql,
  actor: Actor,
  id: number,
  request: ReviewLanguageRequestRequest,
  options: SettingsWriteOptions,
): Promise<LanguageRequestInfo> {
  const userId = actor.type === "user" ? actor.userId : null;
  const selection: Statement = { sql: REQUEST_SQL, params: [userId, id, id] };
  const result = await withRetries(
    sql,
    async () => {
      const [
        revision,
        requests,
        stored,
        languages,
        glossary,
        translations,
        users,
        ...permissionRows
      ] = await sql.read([
        REVISION,
        selection,
        { sql: "SELECT data FROM settings WHERE id = 1" },
        { sql: "SELECT tag, instructions, plural_override, created_at FROM languages" },
        { sql: "SELECT term, language, kind, translation, case_sensitive FROM glossary_terms" },
        {
          sql: "SELECT t.string_id, t.language, t.value, t.qa_errors, t.qa_warnings, s.kind, s.source, s.max_length FROM translations t JOIN strings s ON s.id = t.string_id WHERE t.language = (SELECT tag FROM language_requests WHERE id = ?) AND s.kind IN ('text', 'plural', 'ordinal')",
          params: [id],
        },
        {
          sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN (SELECT requested_by FROM (${selection.sql}) UNION ALL SELECT ?)`,
          params: [...selection.params!, userId],
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          current: requests[0] as Row | undefined,
          stored: (stored[0]?.data as string | undefined) ?? null,
          languages: (languages as LanguageRow[]).map(toLanguage),
          glossary,
          translations: translations as QaRow[],
          actors: new ActorDirectory({ users: users as ActorRows["users"], tokens: [] }),
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    (state) => {
      state.permissions.require("settings");
      const row = state.current;
      if (!row) throw notFound(`Language request ${id}`);
      if (row.status !== "pending")
        throw conflict("That language request has already been reviewed.");
      const approving = request.action === "approve";
      const exists = state.languages.some((language) => language.tag === row.tag);
      const adding = approving && !exists;
      const statements: Statement[] = [];
      if (adding) {
        const settings = settingsFromData(state.stored, options.model);
        if (row.tag === settings.sourceLanguage)
          throw badRequest(`${row.tag} is the source language, so it can't be a target language.`, [
            { language: row.tag },
          ]);
        const language = {
          tag: row.tag,
          instructions: "",
          pluralOverride: undefined,
          createdAt: options.now,
        };
        statements.push({
          sql: "INSERT INTO languages (tag, created_at) VALUES (?, ?)",
          params: [row.tag, options.now],
        });
        statements.push(
          ...planQa(state.translations, {
            sourceLanguage: settings.sourceLanguage,
            syntax: settings.syntax,
            languages: new Map([...state.languages, language].map((entry) => [entry.tag, entry])),
            glossary: state.glossary.map((term) => ({
              term: term.term as string,
              language: term.language as string | null,
              kind: term.kind as "translate" | "keep",
              translation: term.translation as string | null,
              caseSensitive: term.case_sensitive === 1,
            })),
          }),
        );
      }
      const reviewed: Row = {
        ...row,
        status: approving ? "approved" : "rejected",
        reviewed_at: options.now,
        reviewed_by: userId,
      };
      statements.push({
        sql: "UPDATE language_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?",
        params: [reviewed.status, options.now, userId, id],
      });
      return {
        statements,
        result: { info: requestInfos([reviewed], state.actors)[0], added: adding ? row.tag : null },
      };
    },
  );
  if (result.added !== null)
    (options.logger ?? silentLogger).info("Language added", {
      language: result.added,
      actor: { type: actor.type, id: userId },
    });
  return result.info;
}

function requestInfos(rows: Row[], actors: ActorDirectory): LanguageRequestInfo[] {
  return rows.map((r) => ({
    id: r.id,
    tag: r.tag,
    name: languageName(r.tag),
    message: r.message,
    status: r.status,
    requestedBy: actors.user(r.requested_by),
    votes: r.votes,
    voted: r.voted === 1,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: actors.user(r.reviewed_by),
  }));
}
