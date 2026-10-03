// SPDX-License-Identifier: MIT
import type { StringsQuery } from "@quaso/core";
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { getStringsQueueAsync, listStringsAsync } from "../strings.ts";
import { uploadAsync } from "../upload.ts";
import { check, checkEqual } from "./assert.ts";

const LONG = "日本語".repeat(30);

export async function seedStringReads(sql: Sql): Promise<void> {
  await uploadAsync(
    sql,
    SYSTEM_AUTHOR,
    {
      files: [
        {
          path: "common.json",
          repoPath: "common.json",
          content: JSON.stringify({
            title: "Hello",
            play: "Play",
            path: `100% power_up \\ ${LONG}`,
            ref: "$t(title)",
            number: 3,
          }),
        },
        { path: "Menus/main.json", repoPath: "Menus/main.json", content: '{"start":"Start"}' },
      ],
      languages: ["de", "fr"],
    },
    { model: "test", clock: () => 100, llmAvailable: false },
  );
  await sql.commit(1, [
    {
      sql: "INSERT INTO users (id, display_name, created_at) VALUES (1, 'Ada', 100), (2, 'Reviewer', 100)",
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at) VALUES (7, 'CI', 'read', 'hash', 'qso_', 100)",
    },
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, author_id, approver_id, revision, qa_errors, search_text, created_at, updated_at)
      SELECT id, 'de', '"Hallo"', 'green', 'old', 'token', 7, NULL, 2, 1, 'hallo', 100, 100 FROM strings WHERE display_key = 'title'`,
    },
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, author_id, approver_id, revision, search_text, created_at, updated_at)
      SELECT id, 'de', '"Spielen"', 'blue', source_hash, 'user', 1, 2, 2, 'spielen', 100, 100 FROM strings WHERE display_key = 'play'`,
    },
    {
      sql: `INSERT INTO suggestions (string_id, language, kind, source_hash, base_revision, author_type, created_at)
      SELECT id, 'de', 'approval', source_hash, 2, 'system', 100 FROM strings WHERE display_key = 'start'`,
    },
    {
      sql: "INSERT INTO llm_failures (string_id, language, reason, created_at) SELECT id, 'de', 'Provider refused', 100 FROM strings WHERE display_key = 'start'",
    },
  ]);
}

async function keys(sql: Sql, query: Partial<StringsQuery> = {}): Promise<string[]> {
  return (await listStringsAsync(sql, { language: "de", ...query })).strings.map(
    (row) => `${row.file}:${row.key}`,
  );
}

async function rejected(run: () => Promise<unknown>): Promise<ServiceError> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  return failure;
}

export const STRING_LIST_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "queue groups untranslated, outdated and remaining strings and keeps suggestions in their group",
    async run(sql) {
      await seedStringReads(sql);
      const queue = await getStringsQueueAsync(sql, { language: "DE" });
      const [keys] = await sql.read([{ sql: "SELECT id, display_key FROM strings ORDER BY id" }]);
      const byId = new Map(keys.map((row) => [row.id, row.display_key]));
      checkEqual(
        [queue.language, queue.toDo, queue.ids.map((id) => byId.get(id))],
        ["de", 3, ["start", "path", "title", "play"]],
      );
      checkEqual(
        (await getStringsQueueAsync(sql, { language: "de", file: "Menus/" })).ids.map((id) =>
          byId.get(id),
        ),
        ["start"],
      );
      checkEqual((await getStringsQueueAsync(sql, { language: "de", file: "menus/" })).ids, []);
      checkEqual(
        (await getStringsQueueAsync(sql, { language: "de", file: "common.json" })).ids.map((id) =>
          byId.get(id),
        ),
        ["path", "title", "play"],
      );
      checkEqual((await getStringsQueueAsync(sql, { language: "de", state: "pending" })).toDo, 1);
      checkEqual(
        (await getStringsQueueAsync(sql, { language: "de", state: "blue", q: "spielen" })).toDo,
        0,
      );
      checkEqual(
        (await rejected(() => getStringsQueueAsync(sql, { language: "es" }))).code,
        "not_found",
      );
    },
  },
  {
    name: "queue position ties use IDs and old queues remain fixed after a translation",
    async run(sql) {
      await seedStringReads(sql);
      await sql.commit(2, [
        {
          sql: "UPDATE strings SET position = 0 WHERE file_id = (SELECT id FROM files WHERE path = 'common.json')",
        },
      ]);
      const opened = await getStringsQueueAsync(sql, { language: "fr", file: "common.json" });
      const [ids] = await sql.read([
        {
          sql: "SELECT id FROM strings WHERE file_id = (SELECT id FROM files WHERE path = 'common.json') AND kind = 'text' ORDER BY id",
        },
      ]);
      checkEqual(
        opened.ids,
        ids.map((row) => row.id),
      );
      await sql.commit(3, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at)
          SELECT id, 'fr', '"Bonjour"', 'blue', source_hash, 'system', 4, 'bonjour', 100, 100 FROM strings WHERE display_key = 'title'`,
        },
      ]);
      const refreshed = await getStringsQueueAsync(sql, { language: "fr", file: "common.json" });
      checkEqual(
        opened.ids,
        ids.map((row) => row.id),
      );
      checkEqual(refreshed.ids, [opened.ids[1], opened.ids[2], opened.ids[0]]);
      checkEqual([opened.toDo, refreshed.toDo], [3, 2]);
    },
  },
  {
    name: "lists active translatable strings by path and position with actor identities",
    async run(sql) {
      await seedStringReads(sql);
      const page = await listStringsAsync(sql, { language: "DE" });
      checkEqual([page.language, page.total, page.nextCursor], ["de", 4, null]);
      checkEqual(
        page.strings.map((row) => `${row.file}:${row.key}`),
        ["Menus/main.json:start", "common.json:title", "common.json:play", "common.json:path"],
      );
      checkEqual([page.strings[0].pending, page.strings[0].llmFailure], [1, "Provider refused"]);
      checkEqual(page.strings[1].translation?.author, { type: "token", id: 7, name: "CI" });
      checkEqual(page.strings[2].translation?.author, {
        type: "user",
        id: 1,
        name: "Ada",
        avatarUrl: null,
      });
      checkEqual(page.strings[2].translation?.approver, {
        type: "user",
        id: 2,
        name: "Reviewer",
        avatarUrl: null,
      });
    },
  },
  {
    name: "all state filters select the same rows as the existing reader",
    async run(sql) {
      await seedStringReads(sql);
      checkEqual(await keys(sql, { state: "green" }), ["common.json:title"]);
      checkEqual(await keys(sql, { state: "blue" }), ["common.json:play"]);
      checkEqual(await keys(sql, { state: "outdated" }), ["common.json:title"]);
      checkEqual(await keys(sql, { state: "qa" }), ["common.json:title"]);
      checkEqual(await keys(sql, { state: "pending" }), ["Menus/main.json:start"]);
      checkEqual(await keys(sql, { state: "untranslated" }), [
        "Menus/main.json:start",
        "common.json:path",
      ]);
    },
  },
  {
    name: "search normalizes keys and translations and treats punctuation literally",
    async run(sql) {
      await seedStringReads(sql);
      checkEqual(await keys(sql, { q: " HALLO " }), ["common.json:title"]);
      checkEqual(await keys(sql, { q: "ＰＬＡＹ" }), ["common.json:play"]);
      checkEqual(await keys(sql, { q: "100% power_up \\" }), ["common.json:path"]);
      checkEqual(await keys(sql, { q: LONG }), ["common.json:path"]);
      checkEqual(await keys(sql, { q: "no match" }), []);
    },
  },
  {
    name: "file, folder and ID filters are exact and compose with state and search",
    async run(sql) {
      await seedStringReads(sql);
      checkEqual(await keys(sql, { file: "Menus/" }), ["Menus/main.json:start"]);
      checkEqual(await keys(sql, { file: "menus/" }), []);
      checkEqual(await keys(sql, { file: "common.json", state: "green", q: "hallo" }), [
        "common.json:title",
      ]);
      const page = await listStringsAsync(sql, { language: "de", state: "pending" });
      checkEqual(await keys(sql, { ids: [page.strings[0].id] }), ["Menus/main.json:start"]);
      checkEqual(await keys(sql, { ids: [] }), []);
    },
  },
  {
    name: "offset paging keeps totals and returns null at the end",
    async run(sql) {
      await seedStringReads(sql);
      const first = await listStringsAsync(sql, { language: "de", limit: 2 });
      checkEqual([first.total, first.nextCursor, first.strings.length], [4, "2", 2]);
      const second = await listStringsAsync(sql, {
        language: "de",
        limit: 2,
        cursor: first.nextCursor!,
      });
      checkEqual([second.total, second.nextCursor], [4, null]);
      checkEqual(
        second.strings.map((row) => row.key),
        ["play", "path"],
      );
      const past = await listStringsAsync(sql, { language: "de", cursor: "99" });
      checkEqual([past.strings, past.total, past.nextCursor], [[], 4, null]);
    },
  },
  {
    name: "hidden strings and files leave the listing",
    async run(sql) {
      await seedStringReads(sql);
      await sql.commit(2, [
        { sql: "UPDATE files SET active = 0 WHERE path = 'Menus/main.json'" },
        { sql: "UPDATE strings SET active = 0 WHERE display_key = 'play'" },
      ]);
      checkEqual(await keys(sql), ["common.json:title", "common.json:path"]);
    },
  },
  {
    name: "the page and actors survive a concurrent deletion after the snapshot",
    async run(sql) {
      await seedStringReads(sql);
      let reads = 0;
      const snapshotSql: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(2, [
            { sql: "UPDATE strings SET active = 0" },
            { sql: "DELETE FROM users" },
          ]);
          return rows;
        },
      };
      const page = await listStringsAsync(snapshotSql, { language: "de" });
      checkEqual(
        [reads, page.total, page.strings.length, page.strings[2].translation?.author.name],
        [1, 4, 4, "Ada"],
      );
      checkEqual(await keys(sql), []);
    },
  },
  {
    name: "invalid cursors and unknown languages preserve their errors",
    async run(sql) {
      await seedStringReads(sql);
      checkEqual(
        (await rejected(() => listStringsAsync(sql, { language: "de", cursor: "1 OR 1=1" }))).code,
        "bad_request",
      );
      checkEqual(
        (await rejected(() => listStringsAsync(sql, { language: "es" }))).code,
        "not_found",
      );
    },
  },
];
