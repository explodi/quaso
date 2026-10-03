// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql, Statement } from "../ports.ts";
import { reviewSuggestionsAsync, suggestAsync } from "../suggestions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const USER: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };

async function change(sql: Sql, statements: Statement[]) {
  const [rows] = await sql.read([
    { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
  ]);
  await sql.commit(Number(rows[0].revision), statements);
}

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await change(sql, [
    { sql: "UPDATE users SET role = 'contributor' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager', languages = '[\"de\"]' WHERE id = 2" },
  ]);
  const [rows] = await sql.read([{ sql: "SELECT id FROM strings WHERE display_key = 'title'" }]);
  return Number(rows[0].id);
}

async function pending(
  sql: Sql,
  id: number,
  value = "Guten Tag",
  actor = USER,
  language = "de",
  baseRevision = 2,
) {
  return suggestAsync(
    sql,
    actor,
    { id, language, value, kind: "translation", baseRevision },
    200,
    "test",
  );
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

export const SUGGESTION_REVIEW_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "approval writes blue with the author and reviewer and supersedes competing suggestions",
    async run(sql) {
      const id = await seed(sql);
      const mine = await pending(sql, id);
      const other = await pending(sql, id, "Grüß dich", SYSTEM);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [mine.id, other.id, mine.id], action: "approve", comment: "  Merci  " },
        300,
        "test",
      );
      checkEqual(result.approved, [mine.id]);
      checkEqual(
        result.failed.map((row) => [row.id, row.code]),
        [[other.id, "conflict"]],
      );
      const [translations, suggestions, history, activity] = await sql.read([
        {
          sql: "SELECT value, colour, author_type, author_id, approver_id, source_hash, created_at, updated_at, qa_errors FROM translations WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
        {
          sql: "SELECT status, reviewer_id, comment, reviewed_at FROM suggestions WHERE id IN (?, ?) ORDER BY id",
          params: [mine.id, other.id],
        },
        {
          sql: "SELECT event, actor_id, detail FROM history WHERE event IN ('suggestion_approved', 'suggestion_superseded') ORDER BY id",
        },
        { sql: "SELECT summary, detail, created_at FROM activity WHERE type = 'review'" },
      ]);
      checkEqual(translations[0].value, '"Guten Tag"');
      checkEqual(
        [
          translations[0].colour,
          translations[0].author_type,
          translations[0].author_id,
          translations[0].approver_id,
          translations[0].created_at,
          translations[0].updated_at,
          translations[0].qa_errors,
        ],
        ["blue", "user", 1, 2, 100, 300, 0],
      );
      checkEqual(suggestions, [
        { status: "approved", reviewer_id: 2, comment: "Merci", reviewed_at: 300 },
        { status: "superseded", reviewer_id: 2, comment: null, reviewed_at: 300 },
      ]);
      checkEqual(
        history.map((row) => [row.event, row.actor_id]),
        [
          ["suggestion_approved", 2],
          ["suggestion_superseded", 2],
        ],
      );
      checkEqual(JSON.parse(String(history[1].detail)), {
        suggestionId: other.id,
        supersededBy: mine.id,
      });
      checkEqual(activity, [
        {
          summary: "Review (de): 1 approved",
          detail: JSON.stringify({
            kind: "suggestions",
            approved: [mine.id],
            rejected: [],
            failed: 1,
            languages: ["de"],
            comment: "Merci",
          }),
          created_at: 300,
        },
      ]);
    },
  },
  {
    name: "looks-good preserves the original author and clears a successful translation's LLM failure",
    async run(sql) {
      const id = await seed(sql);
      const sent = await suggestAsync(
        sql,
        USER,
        { id, language: "de", kind: "approval", baseRevision: 2 },
        200,
        "test",
      );
      await change(sql, [
        {
          sql: "INSERT INTO llm_failures (string_id, language, reason, created_at) VALUES (?, 'de', 'failure', 100)",
          params: [id],
        },
      ]);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [sent.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(result, { approved: [sent.id], rejected: [], failed: [] });
      const [translation, failures] = await sql.read([
        {
          sql: "SELECT value, colour, author_type, author_id, approver_id FROM translations WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
        { sql: "SELECT reason FROM llm_failures WHERE string_id = ?", params: [id] },
      ]);
      checkEqual(translation, [
        { value: '"Hallo"', colour: "blue", author_type: "token", author_id: 7, approver_id: 2 },
      ]);
      checkEqual(failures, []);
    },
  },
  {
    name: "rejection changes only the suggestion and records one activity for the call",
    async run(sql) {
      const id = await seed(sql);
      const first = await pending(sql, id);
      const second = await pending(sql, id, "Grüß dich", SYSTEM);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [first.id, second.id, first.id], action: "reject", comment: "  Try again  " },
        300,
        "test",
      );
      checkEqual(result, { approved: [], rejected: [first.id, second.id], failed: [] });
      const [translation, history, activity] = await sql.read([
        {
          sql: "SELECT value, colour, revision FROM translations WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
        {
          sql: "SELECT event, detail FROM history WHERE event = 'suggestion_rejected' ORDER BY id",
        },
        { sql: "SELECT summary FROM activity WHERE type = 'review'" },
      ]);
      checkEqual(translation, [{ value: '"Hallo"', colour: "green", revision: 2 }]);
      checkEqual(
        history.map((row) => JSON.parse(String(row.detail))),
        [
          { suggestionId: first.id, comment: "Try again" },
          { suggestionId: second.id, comment: "Try again" },
        ],
      );
      checkEqual(activity, [{ summary: "Review (de): 2 rejected" }]);
    },
  },
  {
    name: "missing, forbidden, finished and QA failures do not prevent a valid approval",
    async run(sql) {
      const id = await seed(sql);
      const good = await pending(sql, id);
      const forbidden = await pending(sql, id, "Bonjour", SYSTEM, "fr", 0);
      const bad = await pending(sql, id, "Very long translation", SYSTEM);
      await change(sql, [{ sql: "UPDATE strings SET max_length = 10 WHERE id = ?", params: [id] }]);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [999, forbidden.id, bad.id, good.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(result.approved, [good.id]);
      checkEqual(
        result.failed.map((row) => [row.id, row.code]),
        [
          [999, "not_found"],
          [forbidden.id, "forbidden"],
          [bad.id, "qa_failed"],
        ],
      );
      check((result.failed[2].checks?.length ?? 0) > 0);
      const repeated = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [good.id], action: "approve" },
        400,
        "test",
      );
      checkEqual(
        repeated.failed.map((row) => row.code),
        ["conflict"],
      );
    },
  },
  {
    name: "stale blue, looks-good and LLM suggestions fail while a correction may replace newer green",
    async run(sql) {
      const id = await seed(sql);
      const correction = await pending(sql, id);
      const approval = await suggestAsync(
        sql,
        SYSTEM,
        { id, language: "de", kind: "approval", baseRevision: 2 },
        200,
        "test",
      );
      const llm = await pending(sql, id, "LLM text", SYSTEM);
      await change(sql, [
        { sql: "UPDATE suggestions SET kind = 'llm' WHERE id = ?", params: [llm.id] },
        {
          sql: "UPDATE translations SET value = '\"New green\"', revision = 99 WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
      ]);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [approval.id, llm.id, correction.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(result.approved, [correction.id]);
      checkEqual(
        result.failed.map((row) => row.code),
        ["conflict", "conflict"],
      );
      const blue = await pending(sql, id, "Another correction", SYSTEM, "de", 8);
      await change(sql, [
        {
          sql: "UPDATE translations SET revision = 100 WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
      ]);
      const stale = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [blue.id], action: "approve" },
        400,
        "test",
      );
      checkEqual(
        stale.failed.map((row) => row.code),
        ["conflict"],
      );
    },
  },
  {
    name: "archived strings and removed languages refuse approval but remain rejectable",
    async run(sql) {
      const id = await seed(sql);
      const archived = await pending(sql, id);
      const removed = await pending(sql, id, "Bonjour", SYSTEM, "fr", 0);
      await change(sql, [
        { sql: "UPDATE strings SET active = 0 WHERE id = ?", params: [id] },
        { sql: "DELETE FROM languages WHERE tag = 'fr'" },
        { sql: "UPDATE users SET languages = NULL WHERE id = 2" },
      ]);
      const refused = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [archived.id, removed.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(refused.approved, []);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [archived.id, removed.id], action: "reject" },
        400,
        "test",
      );
      checkEqual(result.rejected, [archived.id, removed.id]);
    },
  },
  {
    name: "all-failed reviews do not raise the revision or write activity",
    async run(sql) {
      await seed(sql);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: Array.from({ length: 1000 }, (_, i) => i + 1000), action: "approve" },
        300,
        "test",
      );
      checkEqual(result.failed.length, 1000);
      const [revision, activity] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        { sql: "SELECT id FROM activity WHERE type = 'review'" },
      ]);
      checkEqual(revision, [{ value: "3" }]);
      checkEqual(activity, []);
    },
  },
  {
    name: "a competing reviewer wins and retry does not duplicate history or activity",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      const raced = conflict(sql, () =>
        reviewSuggestionsAsync(
          sql,
          MANAGER,
          { ids: [sent.id], action: "reject" },
          250,
          "test",
        ).then(() => {}),
      );
      const result = await reviewSuggestionsAsync(
        raced,
        MANAGER,
        { ids: [sent.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(
        result.failed.map((row) => row.code),
        ["conflict"],
      );
      const [history, activity] = await sql.read([
        {
          sql: "SELECT event FROM history WHERE event IN ('suggestion_approved', 'suggestion_rejected')",
        },
        { sql: "SELECT summary FROM activity WHERE type = 'review'" },
      ]);
      checkEqual(history, [{ event: "suggestion_rejected" }]);
      checkEqual(activity, [{ summary: "Review (de): 1 rejected" }]);
    },
  },
  {
    name: "new competing suggestions are superseded after a conflict and changed source stays outdated",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      const raced = conflict(sql, async () => {
        await pending(sql, id, "Competing", SYSTEM);
        await change(sql, [
          {
            sql: "UPDATE strings SET source = '\"Welcome\"', source_hash = 'new-source' WHERE id = ?",
            params: [id],
          },
        ]);
      });
      const result = await reviewSuggestionsAsync(
        raced,
        MANAGER,
        { ids: [sent.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(result.approved, [sent.id]);
      const [translation, suggestions] = await sql.read([
        {
          sql: "SELECT source_hash FROM translations WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
        { sql: "SELECT status FROM suggestions WHERE string_id = ? ORDER BY id", params: [id] },
      ]);
      const [source] = await sql.read([
        { sql: "SELECT source_hash FROM suggestions WHERE id = ?", params: [sent.id] },
      ]);
      checkEqual(translation, source);
      checkEqual(suggestions, [{ status: "approved" }, { status: "superseded" }]);
    },
  },
  {
    name: "changed QA facts are rechecked after conflicts",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      const raced = conflict(sql, () =>
        change(sql, [{ sql: "UPDATE strings SET max_length = 1 WHERE id = ?", params: [id] }]),
      );
      const result = await reviewSuggestionsAsync(
        raced,
        MANAGER,
        { ids: [sent.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(
        result.failed.map((row) => row.code),
        ["qa_failed"],
      );
      const [rows] = await sql.read([
        { sql: "SELECT status FROM suggestions WHERE id = ?", params: [sent.id] },
      ]);
      checkEqual(rows, [{ status: "pending" }]);
    },
  },
  {
    name: "lost review permission aborts the retry without committing stale authority",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      const raced = conflict(sql, () =>
        change(sql, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 2" }]),
      );
      await rejected(
        () =>
          reviewSuggestionsAsync(
            raced,
            MANAGER,
            { ids: [sent.id], action: "approve" },
            300,
            "test",
          ),
        "forbidden",
      );
      const [rows] = await sql.read([
        { sql: "SELECT status FROM suggestions WHERE id = ?", params: [sent.id] },
      ]);
      checkEqual(rows, [{ status: "pending" }]);
    },
  },
  {
    name: "failed commit rolls back translations, statuses, superseding, history and activity",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      await pending(sql, id, "Other", SYSTEM);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await reviewSuggestionsAsync(
          broken,
          MANAGER,
          { ids: [sent.id], action: "approve" },
          300,
          "test",
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [translation, suggestions, history, activity, revision] = await sql.read([
        {
          sql: "SELECT value, colour FROM translations WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
        { sql: "SELECT status FROM suggestions WHERE string_id = ? ORDER BY id", params: [id] },
        {
          sql: "SELECT event FROM history WHERE event IN ('suggestion_approved', 'suggestion_superseded')",
        },
        { sql: "SELECT id FROM activity WHERE type = 'review'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translation, [{ value: '"Hallo"', colour: "green" }]);
      checkEqual(suggestions, [{ status: "pending" }, { status: "pending" }]);
      checkEqual(history, []);
      checkEqual(activity, []);
      checkEqual(revision, [{ value: "5" }]);
    },
  },
  {
    name: "multiple successful translations share the committed revision and one activity",
    async run(sql) {
      const id = await seed(sql);
      const [strings] = await sql.read([
        { sql: "SELECT id FROM strings WHERE display_key = 'start'" },
      ]);
      const first = await pending(sql, id);
      const second = await pending(sql, Number(strings[0].id), "Starten", SYSTEM, "de", 0);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [first.id, second.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(result, { approved: [first.id, second.id], rejected: [], failed: [] });
      const [translations, revision, activity] = await sql.read([
        {
          sql: "SELECT revision FROM translations WHERE string_id IN (?, ?) AND language = 'de' ORDER BY string_id",
          params: [id, Number(strings[0].id)],
        },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        { sql: "SELECT summary FROM activity WHERE type = 'review'" },
      ]);
      checkEqual(translations, [{ revision: 6 }, { revision: 6 }]);
      checkEqual(revision, [{ value: "6" }]);
      checkEqual(activity, [{ summary: "Review (de): 2 approved" }]);
    },
  },
  {
    name: "a concurrent blue edit makes approval stale and changed language grants refuse rejection",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      const edited = conflict(sql, () =>
        change(sql, [
          {
            sql: "UPDATE translations SET colour = 'blue', revision = 50 WHERE string_id = ? AND language = 'de'",
            params: [id],
          },
        ]),
      );
      const result = await reviewSuggestionsAsync(
        edited,
        MANAGER,
        { ids: [sent.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(
        result.failed.map((row) => row.code),
        ["conflict"],
      );
      const restricted = conflict(sql, () =>
        change(sql, [{ sql: "UPDATE users SET languages = '[\"fr\"]' WHERE id = 2" }]),
      );
      const refused = await reviewSuggestionsAsync(
        restricted,
        MANAGER,
        { ids: [sent.id], action: "reject" },
        400,
        "test",
      );
      checkEqual(
        refused.failed.map((row) => row.code),
        ["forbidden"],
      );
      const [suggestions] = await sql.read([
        { sql: "SELECT status FROM suggestions WHERE id = ?", params: [sent.id] },
      ]);
      checkEqual(suggestions, [{ status: "pending" }]);
    },
  },
  {
    name: "LLM suggestions become blue and removed target languages refuse approval on active strings",
    async run(sql) {
      const id = await seed(sql);
      const llm = await pending(sql, id);
      const removed = await pending(sql, id, "Bonjour", SYSTEM, "fr", 0);
      await change(sql, [
        {
          sql: "UPDATE suggestions SET kind = 'llm', author_type = 'llm', author_id = NULL, author_label = 'test model' WHERE id = ?",
          params: [llm.id],
        },
        { sql: "DELETE FROM languages WHERE tag = 'fr'" },
        { sql: "UPDATE users SET languages = NULL WHERE id = 2" },
      ]);
      const result = await reviewSuggestionsAsync(
        sql,
        MANAGER,
        { ids: [removed.id, llm.id], action: "approve" },
        300,
        "test",
      );
      checkEqual(result.approved, [llm.id]);
      checkEqual(
        result.failed.map((row) => row.code),
        ["bad_request"],
      );
      const [translation] = await sql.read([
        {
          sql: "SELECT colour, author_type, author_label, approver_id FROM translations WHERE string_id = ? AND language = 'de'",
          params: [id],
        },
      ]);
      checkEqual(translation, [
        { colour: "blue", author_type: "llm", author_label: "test model", approver_id: 2 },
      ]);
    },
  },
  {
    name: "validated review enforces input and permission precedence and logs only committed counts",
    async run(sql) {
      const id = await seed(sql);
      const sent = await pending(sql, id);
      const logs: unknown[] = [];
      const methods = asyncWriteMethods({
        sql,
        clock: () => 300,
        logger: {
          debug: () => {},
          info: (...args) => logs.push(args),
          warn: () => {},
          error: () => {},
        },
      });
      await rejected(
        () => methods.reviewSuggestions(ANONYMOUS, { ids: [], action: "approve" }),
        "unauthorized",
      );
      await rejected(
        () => methods.reviewSuggestions(USER, { ids: [], action: "approve" }),
        "forbidden",
      );
      await rejected(
        () => methods.reviewSuggestions(MANAGER, { ids: [], action: "approve" }),
        "validation_failed",
      );
      const result = await methods.reviewSuggestions(SYSTEM, {
        ids: [sent.id],
        action: "reject",
        comment: "private",
      });
      checkEqual(result.rejected, [sent.id]);
      checkEqual(logs, [["Review", { action: "reject", approved: 0, rejected: 1, failed: 0 }]]);
      const [history] = await sql.read([
        {
          sql: "SELECT actor_type, actor_id, actor_label FROM history WHERE event = 'suggestion_rejected'",
        },
      ]);
      checkEqual(history, [{ actor_type: "system", actor_id: null, actor_label: "System" }]);
    },
  },
];
