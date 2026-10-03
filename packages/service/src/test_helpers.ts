// SPDX-License-Identifier: MIT
/**
 * Helpers for the service's tests: a started service on in-memory SQLite, a clock and a
 * scheduler the tests control, and upload shortcuts.
 */
import type { FileContent, Infer, TextValue, TokenScope, UploadRequest } from "@quaso/core";
import { openNodeSqlite } from "./adapters/node_sqlite.ts";
import { type Actor, SYSTEM } from "./api.ts";
import { type Context, FALLBACK_MODEL } from "./context.ts";
import { transaction } from "./db.ts";
import { type KeyedString, matchesKey, parseKeySelector } from "./keys.ts";
import { type Scheduler, silentLogger, type SyncSql } from "./ports.ts";
import { createService, type Service, type ServiceOptions } from "./service.ts";
import { type WriteTranslation, writeTranslation } from "./translations.ts";

/** 2026-09-24, noon UTC. */
export const START_TIME = Date.UTC(2026, 8, 24, 12);

/** A clock that only moves when told to. */
export class TestClock {
  now = START_TIME;
  readonly clock = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** A scheduler that records what it was asked. */
export class FakeScheduler implements Scheduler {
  scheduled: number[] = [];
  cancelled = 0;
  schedule(at: number): void {
    this.scheduled.push(at);
  }
  cancel(): void {
    this.cancelled++;
  }
}

export interface TestInstance {
  service: Service;
  sql: SyncSql;
  /** A context on the same database, for calling the modules directly. */
  ctx: Context;
  clock: TestClock;
  scheduler: FakeScheduler;
  close(): void;
  [Symbol.dispose](): void;
}

/** A started service on a new in-memory database. */
export async function startTestService(
  options: Partial<ServiceOptions> = {},
): Promise<TestInstance> {
  const database = openNodeSqlite(":memory:");
  const clock = new TestClock();
  const scheduler = new FakeScheduler();
  const service = createService({
    sql: database.sql,
    scheduler,
    secretKey: "test",
    clock: clock.clock,
    ...options,
  });
  await service.start();
  const ctx: Context = {
    sql: database.sql,
    clock: clock.clock,
    logger: silentLogger,
    defaultModel: options.defaultModel ?? FALLBACK_MODEL,
  };
  const close = () => database.close();
  return { service, sql: database.sql, ctx, clock, scheduler, close, [Symbol.dispose]: close };
}

/** A JSON file with 2-space indentation and a final newline. */
export function jsonFile(path: string, value: unknown): Infer<typeof FileContent> {
  return { path, content: `${JSON.stringify(value, null, 2)}\n` };
}

/** Uploads JSON files, by path, as the system. */
export function uploadJson(
  service: Service,
  files: Record<string, unknown>,
  extra: Partial<UploadRequest> = {},
  actor: Actor = SYSTEM,
) {
  return service.upload(actor, {
    files: Object.entries(files).map(([path, value]) => ({
      ...jsonFile(path, value),
      repoPath: path,
    })),
    ...extra,
  });
}

/**
 * The ID of the translatable string with a key in a file (a displayed key, or as renames
 * name it, such as `coins#plural`): the active one when there are several.
 */
export function stringId(sql: SyncSql, file: string, key: string): number {
  const selector = parseKeySelector(key);
  const rows = sql
    .query<KeyedString & { id: number; active: number }>(
      `SELECT s.id, s.display_key, s.key_path, s.kind, s.active FROM strings s
     JOIN files f ON f.id = s.file_id
     WHERE f.path = ? AND s.kind IN ('text', 'plural', 'ordinal')`,
      file,
    )
    .filter((row) => matchesKey(selector, row));
  const active = rows.filter((row) => row.active === 1);
  const found = active.length > 0 ? active : rows;
  if (found.length !== 1) throw new Error(`${found.length} strings for ${file} ${key}`);
  return found[0].id;
}

/** Writes a translation through the write path, in its own transaction. */
export function write(
  instance: TestInstance,
  file: string,
  key: string,
  language: string,
  value: TextValue | null,
  extra: Partial<WriteTranslation> = {},
) {
  return transaction(instance.sql, () =>
    writeTranslation(instance.ctx, {
      stringId: stringId(instance.sql, file, key),
      language,
      value,
      colour: "green",
      actor: { type: "llm", id: null, label: "test-model" },
      event: "translation_llm",
      ...extra,
    }),
  );
}

/** Creates an API key and returns its actor and secret. */
export async function createToken(
  service: Service,
  scope: TokenScope,
  name = `${scope} key`,
): Promise<{ actor: Actor; secret: string; id: number }> {
  const created = await service.createApiToken(SYSTEM, { name, scope });
  return { actor: { type: "token", tokenId: created.id }, secret: created.secret, id: created.id };
}

/** Adds a person with a role, as Sprint 6 will. */
export function addUser(
  sql: SyncSql,
  role: "none" | "contributor" | "manager" | "administrator",
  languages: string[] | null = null,
  name = `A ${role}`,
): Actor {
  const [row] = sql.query<{ id: number }>(
    `INSERT INTO users (email, display_name, role, languages, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    `${crypto.randomUUID()}@example.com`,
    name,
    role,
    languages === null ? null : JSON.stringify(languages),
    START_TIME,
  );
  return { type: "user", userId: row.id };
}

/** Counts the rows of a table. */
export function count(sql: SyncSql, table: string, where = "1"): number {
  return sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;
}
