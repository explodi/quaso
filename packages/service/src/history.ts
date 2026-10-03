// SPDX-License-Identifier: MIT
/**
 * A string's history (STR-5) and the project's activity (uploads, imports, jobs, reviews
 * and renames), newest first.
 */
import {
  type ActivityItem,
  type ActivityResult,
  canonicalLanguageTag,
  type Colour,
  type HistoryEntry,
  type HistoryEvent,
  type HistoryResult,
  type TextValue,
} from "@quaso/core";
import { ActorDirectory, type ActorRef, type ActorRows, actorReadStatements } from "./actors.ts";
import type { Context } from "./context.ts";
import { fromJson, fromJsonOrNull } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";
import type { Sql, Statement } from "./ports.ts";

type HistoryRow = {
  id: number;
  string_id: number;
  language: string | null;
  event: HistoryEvent;
  before_value: string | null;
  after_value: string | null;
  before_colour: Colour | null;
  after_colour: Colour | null;
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
  detail: string | null;
  created_at: number;
};

const HISTORY_COLUMNS = `id, string_id, language, event, before_value, after_value,
  before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at`;

/**
 * `GET /strings/{id}/history`: every event of a string, newest first; with a language,
 * that language's events and the English's.
 */
export function getHistory(ctx: Context, id: number, language?: string): HistoryResult {
  const { sql } = ctx;
  if (sql.query("SELECT 1 AS found FROM strings WHERE id = ?", id).length === 0) {
    throw notFound(`String ${id}`);
  }
  const statement = historyStatement(id, language);
  const rows = sql.query<HistoryRow>(statement.sql, ...(statement.params ?? []));
  const actors = new ActorDirectory(sql, rows.map(actorOf));
  return historyResult(rows, actors);
}

function historyStatement(id: number, language?: string): Statement {
  const filter = language === undefined ? "" : " AND (language IS NULL OR language = ?)";
  const params = language === undefined ? [id] : [id, canonicalLanguageTag(language) ?? language];
  return {
    sql: `SELECT ${HISTORY_COLUMNS} FROM history WHERE string_id = ?${filter} ORDER BY id DESC`,
    params,
  };
}

export async function getHistoryAsync(
  sql: Sql,
  id: number,
  language?: string,
): Promise<HistoryResult> {
  const statement = historyStatement(id, language);
  const [found, events, users, tokens] = await sql.read([
    { sql: "SELECT 1 AS found FROM strings WHERE id = ?", params: [id] },
    statement,
    ...actorReadStatements(statement),
  ]);
  if (found.length === 0) throw notFound(`String ${id}`);
  const actors = new ActorDirectory({
    users: users as ActorRows["users"],
    tokens: tokens as ActorRows["tokens"],
  });
  return historyResult(events as HistoryRow[], actors);
}

function historyResult(rows: HistoryRow[], actors: ActorDirectory): HistoryResult {
  return {
    entries: rows.map(
      (row): HistoryEntry => ({
        id: row.id,
        stringId: row.string_id,
        language: row.language,
        event: row.event,
        before: fromJsonOrNull<TextValue>(row.before_value),
        after: fromJsonOrNull<TextValue>(row.after_value),
        beforeColour: row.before_colour,
        afterColour: row.after_colour,
        actor: actors.info(actorOf(row)),
        detail: fromJsonOrNull<Record<string, unknown>>(row.detail),
        createdAt: row.created_at,
      }),
    ),
  };
}

function actorOf(row: {
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
}): ActorRef {
  return { type: row.actor_type, id: row.actor_id, label: row.actor_label };
}

/** Activity items per page when the query doesn't say. */
export const DEFAULT_ACTIVITY_LIMIT = 50;

type ActivityRow = {
  id: number;
  type: ActivityItem["type"];
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
  summary: string;
  detail: string;
  created_at: number;
};

/** `GET /activity`: newest first; the cursor is the last item's ID. */
export function getActivity(ctx: Context, cursor?: string, limit?: number): ActivityResult {
  const size = limit ?? DEFAULT_ACTIVITY_LIMIT;
  const statement = activityStatement(cursor, size);
  const rows = ctx.sql.query<ActivityRow>(statement.sql, ...(statement.params ?? []));
  const actors = new ActorDirectory(ctx.sql, rows.slice(0, size).map(actorOf));
  return activityResult(rows, actors, size);
}

function activityStatement(cursor: string | undefined, size: number): Statement {
  if (cursor !== undefined && cursor !== "" && !/^\d{1,15}$/.test(cursor)) {
    throw badRequest("The cursor is invalid.");
  }
  const before = cursor === undefined || cursor === "" ? Number.MAX_SAFE_INTEGER : Number(cursor);
  return {
    sql: `SELECT id, type, actor_type, actor_id, actor_label, summary, detail, created_at
     FROM activity WHERE id < ? ORDER BY id DESC LIMIT ?`,
    params: [before, size + 1],
  };
}

export async function getActivityAsync(
  sql: Sql,
  cursor?: string,
  limit?: number,
): Promise<ActivityResult> {
  const size = limit ?? DEFAULT_ACTIVITY_LIMIT;
  const statement = activityStatement(cursor, size);
  const [events, users, tokens] = await sql.read([statement, ...actorReadStatements(statement)]);
  const actors = new ActorDirectory({
    users: users as ActorRows["users"],
    tokens: tokens as ActorRows["tokens"],
  });
  return activityResult(events as ActivityRow[], actors, size);
}

function activityResult(rows: ActivityRow[], actors: ActorDirectory, size: number): ActivityResult {
  const page = rows.slice(0, size);
  return {
    items: page.map((row) => ({
      id: String(row.id),
      type: row.type,
      at: row.created_at,
      actor: actors.info(actorOf(row)),
      summary: row.summary,
      detail: fromJson<Record<string, unknown>>(row.detail),
    })),
    nextCursor: rows.length > size ? String(page[page.length - 1].id) : null,
  };
}
