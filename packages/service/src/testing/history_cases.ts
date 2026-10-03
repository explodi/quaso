// SPDX-License-Identifier: MIT
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import { getActivityAsync, getHistoryAsync } from "../history.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { check, checkEqual } from "./assert.ts";

async function seed(sql: Sql): Promise<void> {
  await uploadAsync(
    sql,
    SYSTEM_AUTHOR,
    {
      files: [{ path: "a.json", repoPath: "a.json", content: '{"hello":"Hello"}' }],
      languages: ["de", "fr"],
    },
    { model: "test", clock: () => 100, llmAvailable: false },
  );
  await sql.commit(1, [
    {
      sql: "INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (1, 'Ada', 'https://example.com/ada.png', 100)",
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at) VALUES (7, 'CI', 'read', 'hash', 'qso_', 100)",
    },
    {
      sql: `INSERT INTO history (id, string_id, language, event, before_value, after_value,
      before_colour, after_colour, actor_type, actor_id, actor_label, detail, created_at) VALUES
      (100, 1, 'de', 'translation_saved', NULL, '"Hallo"', NULL, 'blue', 'user', 1, NULL, '{"note":"proofread"}', 101),
      (101, 1, 'fr', 'translation_saved', '"Salut"', '"Bonjour"', 'green', 'green', 'llm', NULL, 'Model', NULL, 102),
      (102, 1, NULL, 'source_changed', '"Hello"', '"Hello again"', NULL, NULL, 'token', 7, 'Old token', NULL, 99)`,
    },
    {
      sql: `INSERT INTO activity (id, type, actor_type, actor_id, actor_label, summary, detail, created_at) VALUES
      (200, 'review', 'user', 1, NULL, 'Reviewed', '{"count":1}', 101),
      (201, 'import', 'token', 7, 'Old token', 'Imported', '{}', 102),
      (202, 'llm', 'llm', NULL, 'Model', 'Translated', '{}', 99)`,
    },
  ]);
}

async function rejects(run: () => Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const HISTORY_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "history includes source events and canonical language events newest by ID",
    async run(sql) {
      await seed(sql);
      const result = await getHistoryAsync(sql, 1, "DE");
      checkEqual(
        result.entries.map((entry) => [entry.id, entry.language, entry.actor.name]),
        [
          [102, null, "CI"],
          [100, "de", "Ada"],
          [1, null, "System"],
        ],
      );
      checkEqual(result.entries[1], {
        id: 100,
        stringId: 1,
        language: "de",
        event: "translation_saved",
        before: null,
        after: "Hallo",
        beforeColour: null,
        afterColour: "blue",
        actor: { type: "user", id: 1, name: "Ada", avatarUrl: "https://example.com/ada.png" },
        detail: { note: "proofread" },
        createdAt: 101,
      });
      checkEqual(
        (await getHistoryAsync(sql, 1)).entries.map((entry) => entry.id),
        [102, 101, 100, 1],
      );
      checkEqual(
        (await getHistoryAsync(sql, 1, "unknown")).entries.map((entry) => entry.id),
        [102, 1],
      );
    },
  },
  {
    name: "activity pagination uses an exclusive ID cursor and a lookahead row",
    async run(sql) {
      await seed(sql);
      const first = await getActivityAsync(sql, undefined, 2);
      checkEqual(
        first.items.map((item) => [item.id, item.at, item.actor.name]),
        [
          ["202", 99, "Model"],
          ["201", 102, "CI"],
        ],
      );
      checkEqual(first.nextCursor, "201");
      const second = await getActivityAsync(sql, first.nextCursor!, 2);
      checkEqual(
        second.items.map((item) => item.id),
        ["200", "1"],
      );
      checkEqual(second.items[0].detail, { count: 1 });
      checkEqual(second.nextCursor, null);
      checkEqual(await getActivityAsync(sql, "1", 2), { items: [], nextCursor: null });
      checkEqual((await getActivityAsync(sql, "")).items.length, 4);
    },
  },
  {
    name: "missing strings are not found but hidden strings retain history",
    async run(sql) {
      await seed(sql);
      await rejects(() => getHistoryAsync(sql, 999), "not_found");
      await sql.commit(2, [{ sql: "UPDATE strings SET active = 0" }]);
      checkEqual((await getHistoryAsync(sql, 1)).entries.length, 4);
    },
  },
  {
    name: "deleted actors use the same stored labels and fallbacks",
    async run(sql) {
      await seed(sql);
      await sql.commit(2, [
        { sql: "DELETE FROM users WHERE id = 1" },
        { sql: "DELETE FROM api_tokens WHERE id = 7" },
      ]);
      const history = await getHistoryAsync(sql, 1, "de");
      checkEqual(history.entries[0].actor, { type: "token", id: 7, name: "Old token" });
      checkEqual(history.entries[1].actor, {
        type: "user",
        id: 1,
        name: "Deleted user",
        avatarUrl: null,
      });
      const activity = await getActivityAsync(sql);
      checkEqual(activity.items[1].actor.name, "Old token");
      checkEqual(activity.items[2].actor.name, "Deleted user");
    },
  },
  {
    name: "actor names and events remain in one snapshot during a concurrent rename",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const snapshotSql: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(2, [{ sql: "UPDATE users SET display_name = 'Renamed' WHERE id = 1" }]);
          return rows;
        },
      };
      const history = await getHistoryAsync(snapshotSql, 1, "de");
      checkEqual([reads, history.entries[1].actor.name], [1, "Ada"]);
      checkEqual((await getActivityAsync(sql)).items[2].actor.name, "Renamed");
    },
  },
  {
    name: "empty activity and invalid cursors preserve the existing behavior",
    async run(sql) {
      checkEqual(await getActivityAsync(sql), { items: [], nextCursor: null });
      await rejects(() => getActivityAsync(sql, "1 OR 1=1"), "bad_request");
      await rejects(() => getActivityAsync(sql, "1234567890123456"), "bad_request");
    },
  },
];
