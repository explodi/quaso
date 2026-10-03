// SPDX-License-Identifier: MIT
/**
 * Who did something: the author recorded with a change, and the `ActorInfo` shown for it
 * (a person's name and avatar, an API key's name, the model, "Import" or "System").
 */
import type { ActorInfo, AuthorType } from "@quaso/core";
import type { Actor } from "./api.ts";
import type { Context } from "./context.ts";
import { idList } from "./db.ts";
import { unauthorized } from "./errors.ts";
import type { Statement, SyncSql } from "./ports.ts";

/** The author of a change, as the tables store it (`author_*`, `actor_*`). */
export interface Author {
  type: AuthorType;
  id: number | null;
  /** The API key's name, the model, "Import" or "System": kept for display. */
  label: string | null;
}

export const IMPORT_AUTHOR: Author = { type: "import", id: null, label: "Import" };
export const SYSTEM_AUTHOR: Author = { type: "system", id: null, label: "System" };

/** The author a caller's changes are recorded under. Anonymous callers write nothing. */
export function authorFor(ctx: Context, actor: Actor): Author {
  switch (actor.type) {
    case "user":
      return { type: "user", id: actor.userId, label: null };
    case "token": {
      const rows = ctx.sql.query<{ name: string }>(
        "SELECT name FROM api_tokens WHERE id = ?",
        actor.tokenId,
      );
      return { type: "token", id: actor.tokenId, label: rows[0]?.name ?? null };
    }
    case "system":
      return SYSTEM_AUTHOR;
    case "anonymous":
      throw unauthorized();
  }
}

/** An author as a row has it: a type, an ID and a label. */
export interface ActorRef {
  type: string;
  id: number | null;
  label: string | null;
}

export interface ActorRows {
  users: { id: number; display_name: string; avatar_url: string | null }[];
  tokens: { id: number; name: string }[];
}

/** Resolve identities in the same batch as the events that reference them. */
export function actorReadStatements(events: Statement): Statement[] {
  const referenced = `SELECT actor_id FROM (${events.sql}) WHERE actor_type = ?`;
  return [
    {
      sql: `SELECT id, display_name, avatar_url FROM users WHERE id IN (${referenced})`,
      params: [...(events.params ?? []), "user"],
    },
    {
      sql: `SELECT id, name FROM api_tokens WHERE id IN (${referenced})`,
      params: [...(events.params ?? []), "token"],
    },
  ];
}

/**
 * Turns stored authors into `ActorInfo`, loading the people and API keys they name with one
 * query each.
 */
export class ActorDirectory {
  readonly #users = new Map<number, { name: string; avatarUrl: string | null }>();
  readonly #tokens = new Map<number, string>();

  constructor(
    source: SyncSql | ActorRows,
    refs: Iterable<ActorRef> = [],
    userIds: Iterable<number | null> = [],
  ) {
    const rows = "query" in source ? loadActorRows(source, refs, userIds) : source;
    for (const row of rows.users)
      this.#users.set(row.id, { name: row.display_name, avatarUrl: row.avatar_url });
    for (const row of rows.tokens) this.#tokens.set(row.id, row.name);
  }

  /** The `ActorInfo` of a stored author. */
  info(ref: ActorRef): ActorInfo {
    switch (ref.type) {
      case "user": {
        const user = ref.id === null ? undefined : this.#users.get(ref.id);
        return {
          type: "user",
          id: ref.id,
          name: user?.name ?? ref.label ?? "Deleted user",
          avatarUrl: user?.avatarUrl ?? null,
        };
      }
      case "token": {
        const name = ref.id === null ? undefined : this.#tokens.get(ref.id);
        return { type: "token", id: ref.id, name: name ?? ref.label ?? "Deleted API key" };
      }
      case "llm":
        return { type: "llm", id: null, name: ref.label ?? "LLM" };
      case "import":
        return { type: "import", id: null, name: ref.label ?? "Import" };
      case "system":
        return { type: "system", id: null, name: ref.label ?? "System" };
      default:
        return { type: "anonymous", id: null, name: ref.label ?? "Anonymous" };
    }
  }

  /** A person, by ID, or `null` without one. */
  user(id: number | null): ActorInfo | null {
    return id === null ? null : this.info({ type: "user", id, label: null });
  }
}

function loadActorRows(
  sql: SyncSql,
  refs: Iterable<ActorRef>,
  userIds: Iterable<number | null>,
): ActorRows {
  const users = new Set<number>();
  const tokens = new Set<number>();
  for (const ref of refs) {
    if (ref.id === null) continue;
    if (ref.type === "user") users.add(ref.id);
    else if (ref.type === "token") tokens.add(ref.id);
  }
  for (const id of userIds) if (id !== null) users.add(id);
  return {
    users:
      users.size === 0
        ? []
        : sql.query<ActorRows["users"][number]>(
            `SELECT id, display_name, avatar_url FROM users WHERE id IN (${idList(users)})`,
          ),
    tokens:
      tokens.size === 0
        ? []
        : sql.query<ActorRows["tokens"][number]>(
            `SELECT id, name FROM api_tokens WHERE id IN (${idList(tokens)})`,
          ),
  };
}
