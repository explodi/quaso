// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import type { Sql, Statement } from "../ports.ts";
import { renameKeyAsync } from "../rename.ts";
import { suggestAsync } from "../suggestions.ts";
import { uploadAsync } from "../upload.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 2 };
const USER: Actor = { type: "user", userId: 1 };
const REQUEST = { file: "common.json", from: "title", to: "greeting" };

async function change(sql: Sql, statements: Statement[]) {
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
  ]);
  await sql.commit(Number(rows[0].revision), statements);
}

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await change(sql, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 2" },
    { sql: "UPDATE users SET role = 'contributor' WHERE id = 1" },
  ]);
  const [old] = await sql.read([{ sql: "SELECT id FROM strings WHERE display_key = 'title'" }]);
  const from = Number(old[0].id);
  const suggestion = await suggestAsync(
    sql,
    USER,
    { id: from, language: "de", kind: "correction", value: "Guten Tag", baseRevision: 2 },
    150,
    "test",
  );
  await uploadAsync(
    sql,
    SYSTEM_AUTHOR,
    {
      files: [
        {
          path: "common.json",
          repoPath: "common.json",
          content: '{"greeting":"Hello {{name}}","play":"Play"}',
        },
      ],
    },
    { model: "test", clock: () => 160, llmAvailable: false },
  );
  const [target] = await sql.read([
    { sql: "SELECT id FROM strings WHERE display_key = 'greeting'" },
  ]);
  return { from, to: Number(target[0].id), suggestion: suggestion.id };
}

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
  return failure;
}

function conflict(sql: Sql, update: () => Promise<void>): Sql {
  let first = true;
  return {
    ...sql,
    async read(statements) {
      const rows = await sql.read(statements);
      if (first) {
        first = false;
        await update();
      }
      return rows;
    },
  };
}

function targetTranslation(
  id: number,
  author = "llm",
  colour = "green",
  language = "de",
): Statement {
  return {
    sql: "INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, author_label, revision, qa_errors, qa_warnings, search_text, created_at, updated_at) VALUES (?, ?, '\"New {{name}}\"', ?, 'target-source', ?, 'test model', 5, 0, 0, 'new', 160, 160)",
    params: [id, language, colour, author],
  };
}

export const RENAME_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "renaming moves translations, suggestions and history and refreshes QA atomically",
    async run(sql) {
      const ids = await seed(sql);
      await change(sql, [
        {
          sql: "INSERT INTO llm_failures (string_id, language, reason, created_at) VALUES (?, 'de', 'Failure', 160)",
          params: [ids.to],
        },
      ]);
      const result = await renameKeyAsync(sql, ADMIN, REQUEST, 200, "test");
      checkEqual(result, { renamed: [REQUEST], revision: 7 });
      const [translations, suggestions, oldHistory, history, activity, failures] = await sql.read([
        {
          sql: "SELECT string_id, value, source_hash, revision, author_type, author_id, qa_errors FROM translations WHERE string_id IN (?, ?) ORDER BY string_id",
          params: [ids.from, ids.to],
        },
        { sql: "SELECT string_id, status FROM suggestions WHERE id = ?", params: [ids.suggestion] },
        { sql: "SELECT id FROM history WHERE string_id = ?", params: [ids.from] },
        {
          sql: "SELECT event, detail, actor_id, created_at FROM history WHERE string_id = ? AND event = 'source_renamed'",
          params: [ids.to],
        },
        { sql: "SELECT summary, detail FROM activity WHERE type = 'rename'" },
        { sql: "SELECT reason FROM llm_failures WHERE string_id = ?", params: [ids.to] },
      ]);
      checkEqual(translations, [
        {
          string_id: ids.to,
          value: '"Hallo"',
          source_hash: "old",
          revision: 2,
          author_type: "token",
          author_id: 7,
          qa_errors: 1,
        },
      ]);
      checkEqual(suggestions, [{ string_id: ids.to, status: "pending" }]);
      checkEqual(oldHistory, []);
      checkEqual(history, [
        {
          event: "source_renamed",
          detail: JSON.stringify({ ...REQUEST, fromStringId: ids.from }),
          actor_id: 2,
          created_at: 200,
        },
      ]);
      checkEqual(activity[0].summary, "Renamed title to greeting in common.json");
      checkEqual(JSON.parse(String(activity[0].detail)), {
        ...REQUEST,
        fromStringId: ids.from,
        toStringId: ids.to,
      });
      checkEqual(failures, []);
    },
  },
  {
    name: "LLM-only target clashes give way with deletion history while other languages stay",
    async run(sql) {
      const ids = await seed(sql);
      await change(sql, [
        targetTranslation(ids.to),
        targetTranslation(ids.to, "llm", "green", "fr"),
      ]);
      const result = await renameKeyAsync(sql, ADMIN, REQUEST, 200, "test");
      checkEqual(result.renamed, [REQUEST]);
      const [translations, history] = await sql.read([
        {
          sql: "SELECT language, value FROM translations WHERE string_id = ? ORDER BY language",
          params: [ids.to],
        },
        {
          sql: "SELECT before_value, after_value, detail FROM history WHERE string_id = ? AND event = 'translation_deleted'",
          params: [ids.to],
        },
      ]);
      checkEqual(translations, [
        { language: "de", value: '"Hallo"' },
        { language: "fr", value: '"New {{name}}"' },
      ]);
      checkEqual(history[0].before_value, '"New {{name}}"');
      checkEqual(history[0].after_value, null);
      checkEqual(JSON.parse(String(history[0].detail)), { reason: "rename", ...REQUEST });
    },
  },
  {
    name: "person-authored, proofread and person-reviewed target translations are protected",
    async run(sql) {
      const ids = await seed(sql);
      await change(sql, [targetTranslation(ids.to, "user")]);
      await rejected(() => renameKeyAsync(sql, ADMIN, REQUEST, 200, "test"), "bad_request");
      await change(sql, [
        {
          sql: "UPDATE translations SET author_type = 'llm', colour = 'blue' WHERE string_id = ?",
          params: [ids.to],
        },
      ]);
      await rejected(() => renameKeyAsync(sql, ADMIN, REQUEST, 200, "test"), "bad_request");
      await change(sql, [
        { sql: "UPDATE translations SET colour = 'green' WHERE string_id = ?", params: [ids.to] },
        {
          sql: "INSERT INTO history (string_id, language, event, actor_type, actor_id, created_at) VALUES (?, 'de', 'translation_saved', 'user', 2, 180)",
          params: [ids.to],
        },
      ]);
      const error = await rejected(
        () => renameKeyAsync(sql, ADMIN, REQUEST, 200, "test"),
        "bad_request",
      );
      checkEqual(error.details?.[0].language, "de");
      const [old] = await sql.read([
        { sql: "SELECT value FROM translations WHERE string_id = ?", params: [ids.from] },
      ]);
      checkEqual(old, [{ value: '"Hallo"' }]);
    },
  },
  {
    name: "repeated renames are no-ops without extra history, activity or revision",
    async run(sql) {
      await seed(sql);
      await renameKeyAsync(sql, ADMIN, REQUEST, 200, "test");
      checkEqual(await renameKeyAsync(sql, ADMIN, REQUEST, 250, "test"), {
        renamed: [],
        revision: 6,
      });
      const [history, activity] = await sql.read([
        { sql: "SELECT COUNT(*) AS count FROM history WHERE event = 'source_renamed'" },
        { sql: "SELECT COUNT(*) AS count FROM activity WHERE type = 'rename'" },
      ]);
      checkEqual(history, [{ count: 1 }]);
      checkEqual(activity, [{ count: 1 }]);
    },
  },
  {
    name: "settings permission and source, target and active-file rules apply before writes",
    async run(sql) {
      await seed(sql);
      await rejected(() => renameKeyAsync(sql, ANONYMOUS, REQUEST, 200, "test"), "unauthorized");
      await rejected(() => renameKeyAsync(sql, USER, REQUEST, 200, "test"), "forbidden");
      await rejected(
        () => renameKeyAsync(sql, { type: "token", tokenId: 7 }, REQUEST, 200, "test"),
        "forbidden",
      );
      await rejected(
        () => renameKeyAsync(sql, ADMIN, { ...REQUEST, from: "play" }, 200, "test"),
        "bad_request",
      );
      await rejected(
        () => renameKeyAsync(sql, ADMIN, { ...REQUEST, to: "missing" }, 200, "test"),
        "bad_request",
      );
      await change(sql, [{ sql: "UPDATE files SET active = 0 WHERE path = 'common.json'" }]);
      await rejected(() => renameKeyAsync(sql, ADMIN, REQUEST, 200, "test"), "bad_request");
    },
  },
  {
    name: "matching kinds and exact key paths prevent ambiguous renames",
    async run(sql) {
      const ids = await seed(sql);
      await change(sql, [
        { sql: "UPDATE strings SET kind = 'plural' WHERE id = ?", params: [ids.to] },
      ]);
      await rejected(() => renameKeyAsync(sql, ADMIN, REQUEST, 200, "test"), "bad_request");
      await change(sql, [
        {
          sql: "UPDATE strings SET kind = 'text', display_key = 'a.b', key_path = '[\"a.b\"]' WHERE id = ?",
          params: [ids.from],
        },
        { sql: "UPDATE strings SET kind = 'text' WHERE id = ?", params: [ids.to] },
        {
          sql: "UPDATE strings SET display_key = 'a.b', key_path = '[\"a\",\"b\"]' WHERE display_key = 'path'",
        },
      ]);
      await rejected(
        () => renameKeyAsync(sql, ADMIN, { ...REQUEST, from: "a.b" }, 200, "test"),
        "bad_request",
      );
      const exact = { ...REQUEST, from: '["a.b"]' };
      checkEqual((await renameKeyAsync(sql, ADMIN, exact, 200, "test")).renamed, [exact]);
    },
  },
  {
    name: "a competing rename succeeds once and retry becomes a no-op",
    async run(sql) {
      await seed(sql);
      const raced = conflict(sql, () =>
        renameKeyAsync(sql, ADMIN, REQUEST, 150, "test").then(() => {}),
      );
      checkEqual(await renameKeyAsync(raced, ADMIN, REQUEST, 200, "test"), {
        renamed: [],
        revision: 6,
      });
      const [history] = await sql.read([
        { sql: "SELECT created_at FROM history WHERE event = 'source_renamed'" },
      ]);
      checkEqual(history, [{ created_at: 150 }]);
    },
  },
  {
    name: "a person's new target translation blocks a stale rename on retry",
    async run(sql) {
      const ids = await seed(sql);
      const raced = conflict(sql, () => change(sql, [targetTranslation(ids.to, "user")]));
      await rejected(() => renameKeyAsync(raced, ADMIN, REQUEST, 200, "test"), "bad_request");
      const [old] = await sql.read([
        { sql: "SELECT value FROM translations WHERE string_id = ?", params: [ids.from] },
      ]);
      checkEqual(old, [{ value: '"Hallo"' }]);
    },
  },
  {
    name: "changed QA facts and source translations are refreshed after a conflict",
    async run(sql) {
      const ids = await seed(sql);
      const raced = conflict(sql, () =>
        change(sql, [
          {
            sql: "UPDATE strings SET source = '\"Hello\"', max_length = 1 WHERE id = ?",
            params: [ids.to],
          },
          {
            sql: "UPDATE translations SET value = '\"Hi\"', qa_errors = 0 WHERE string_id = ?",
            params: [ids.from],
          },
        ]),
      );
      await renameKeyAsync(raced, ADMIN, REQUEST, 200, "test");
      const [rows] = await sql.read([
        { sql: "SELECT value, qa_errors FROM translations WHERE string_id = ?", params: [ids.to] },
      ]);
      checkEqual(rows, [{ value: '"Hi"', qa_errors: 1 }]);
    },
  },
  {
    name: "administrator demotion aborts retry without moving data",
    async run(sql) {
      const ids = await seed(sql);
      const raced = conflict(sql, () =>
        change(sql, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 2" }]),
      );
      await rejected(() => renameKeyAsync(raced, ADMIN, REQUEST, 200, "test"), "forbidden");
      const [rows] = await sql.read([
        { sql: "SELECT value FROM translations WHERE string_id = ?", params: [ids.from] },
      ]);
      checkEqual(rows, [{ value: '"Hallo"' }]);
    },
  },
  {
    name: "failed commit rolls back movement, replacement, QA, history and activity",
    async run(sql) {
      const ids = await seed(sql);
      await change(sql, [targetTranslation(ids.to)]);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await renameKeyAsync(broken, ADMIN, REQUEST, 200, "test");
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [translations, suggestions, history, activity, revision] = await sql.read([
        {
          sql: "SELECT string_id, value FROM translations WHERE string_id IN (?, ?) ORDER BY string_id",
          params: [ids.from, ids.to],
        },
        { sql: "SELECT string_id FROM suggestions WHERE id = ?", params: [ids.suggestion] },
        {
          sql: "SELECT event FROM history WHERE event IN ('source_renamed', 'translation_deleted')",
        },
        { sql: "SELECT id FROM activity WHERE type = 'rename'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translations, [
        { string_id: ids.from, value: '"Hallo"' },
        { string_id: ids.to, value: '"New {{name}}"' },
      ]);
      checkEqual(suggestions, [{ string_id: ids.from }]);
      checkEqual(history, []);
      checkEqual(activity, []);
      checkEqual(revision, [{ value: "6" }]);
    },
  },
  {
    name: "validated entry points retain permission precedence and log successful renames only",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const methods = asyncWriteMethods({
        sql,
        clock: () => 200,
        logger: {
          debug: () => {},
          info: (...args) => logs.push(args),
          warn: () => {},
          error: () => {},
        },
      });
      await rejected(() => methods.renameKey(USER, { ...REQUEST, file: "../bad" }), "forbidden");
      await rejected(
        () => methods.renameKey(ADMIN, { ...REQUEST, file: "../bad" }),
        "validation_failed",
      );
      const result = await methods.renameKey(SYSTEM, REQUEST);
      checkEqual(result.renamed, [REQUEST]);
      await methods.renameKey(SYSTEM, REQUEST);
      checkEqual(logs, [["Key renamed", REQUEST]]);
      const [history] = await sql.read([
        {
          sql: "SELECT actor_type, actor_id, actor_label FROM history WHERE event = 'source_renamed'",
        },
      ]);
      checkEqual(history, [{ actor_type: "system", actor_id: null, actor_label: "System" }]);
    },
  },
];
