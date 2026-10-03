// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { editTranslationAsync } from "../edits.ts";
import { ServiceError } from "../errors.ts";
import type { Sql, Statement } from "../ports.ts";
import { suggestAsync } from "../suggestions.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const MANAGER: Actor = { type: "user", userId: 2 };
const USER: Actor = { type: "user", userId: 1 };

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
  return { id: Number(rows[0].id), language: "de", baseRevision: 2 };
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

export const TRANSLATION_EDIT_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "save writes blue with fresh metadata, canonical language, search text and history",
    async run(sql) {
      const target = await seed(sql);
      const result = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "save", input: { ...target, language: "DE", value: "Guten Tag" } },
        200,
        "test",
      );
      checkEqual(
        [
          result.translation?.value,
          result.translation?.colour,
          result.translation?.outdated,
          result.translation?.revision,
          result.translation?.author.name,
          result.translation?.approver?.name,
        ],
        ["Guten Tag", "blue", false, 4, "Reviewer", "Reviewer"],
      );
      const [translation, history] = await sql.read([
        {
          sql: "SELECT value, search_text, created_at, updated_at, revision FROM translations WHERE string_id = ? AND language = 'de'",
          params: [target.id],
        },
        {
          sql: "SELECT event, before_value, after_value, actor_id, created_at FROM history WHERE event = 'translation_saved'",
        },
      ]);
      checkEqual(translation, [
        {
          value: '"Guten Tag"',
          search_text: "guten tag",
          created_at: 100,
          updated_at: 200,
          revision: 4,
        },
      ]);
      checkEqual(history, [
        {
          event: "translation_saved",
          before_value: '"Hallo"',
          after_value: '"Guten Tag"',
          actor_id: 2,
          created_at: 200,
        },
      ]);
    },
  },
  {
    name: "approval preserves the author and confirms an outdated translation for current English",
    async run(sql) {
      const target = await seed(sql);
      const result = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "approve", input: target },
        200,
        "test",
      );
      checkEqual(
        [
          result.translation?.value,
          result.translation?.colour,
          result.translation?.outdated,
          result.translation?.author.name,
          result.translation?.approver?.name,
        ],
        ["Hallo", "blue", false, "CI", "Reviewer"],
      );
      const [history] = await sql.read([
        {
          sql: "SELECT event, before_colour, after_colour FROM history WHERE event = 'translation_approved'",
        },
      ]);
      checkEqual(history, [
        { event: "translation_approved", before_colour: "green", after_colour: "blue" },
      ]);
    },
  },
  {
    name: "unapproval retains source and author, allows QA errors and deletion records red history",
    async run(sql) {
      const target = await seed(sql);
      await change(sql, [
        {
          sql: "UPDATE translations SET colour = 'blue', approver_id = 2 WHERE string_id = ? AND language = 'de'",
          params: [target.id],
        },
        { sql: "UPDATE strings SET max_length = 1 WHERE id = ?", params: [target.id] },
      ]);
      const green = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "unapprove", input: target },
        200,
        "test",
      );
      checkEqual(
        [
          green.translation?.colour,
          green.translation?.outdated,
          green.translation?.author.name,
          green.translation?.approver,
          green.translation?.revision,
        ],
        ["green", true, "CI", null, 5],
      );
      const [qa] = await sql.read([
        {
          sql: "SELECT source_hash, qa_errors FROM translations WHERE string_id = ? AND language = 'de'",
          params: [target.id],
        },
      ]);
      checkEqual(qa, [{ source_hash: "old", qa_errors: 1 }]);
      const red = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "delete", input: { ...target, baseRevision: 5 } },
        300,
        "test",
      );
      checkEqual(red, { translation: null });
      const [history] = await sql.read([
        {
          sql: "SELECT event, before_colour, after_colour FROM history WHERE event IN ('translation_unapproved', 'translation_deleted') ORDER BY id",
        },
      ]);
      checkEqual(history, [
        { event: "translation_unapproved", before_colour: "blue", after_colour: "green" },
        { event: "translation_deleted", before_colour: "green", after_colour: null },
      ]);
    },
  },
  {
    name: "no-op saves, approvals, unapprovals and red deletions leave the project unchanged",
    async run(sql) {
      const target = await seed(sql);
      const blue = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "approve", input: target },
        200,
        "test",
      );
      const approved = { ...target, baseRevision: blue.translation!.revision };
      await editTranslationAsync(sql, MANAGER, { action: "approve", input: approved }, 250, "test");
      await editTranslationAsync(
        sql,
        MANAGER,
        { action: "save", input: { ...approved, value: "Hallo" } },
        250,
        "test",
      );
      const green = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "unapprove", input: approved },
        300,
        "test",
      );
      await editTranslationAsync(
        sql,
        MANAGER,
        { action: "unapprove", input: { ...target, baseRevision: green.translation!.revision } },
        350,
        "test",
      );
      await editTranslationAsync(
        sql,
        SYSTEM,
        { action: "delete", input: { ...target, language: "fr", baseRevision: 0 } },
        350,
        "test",
      );
      const [revision, history] = await sql.read([
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        { sql: "SELECT event FROM history WHERE event LIKE 'translation_%' ORDER BY id" },
      ]);
      checkEqual(revision, [{ value: "5" }]);
      checkEqual(history, [{ event: "translation_approved" }, { event: "translation_unapproved" }]);
    },
  },
  {
    name: "stale revisions return the current translation and deleted translations return null",
    async run(sql) {
      const target = await seed(sql);
      const stale = await rejected(
        () =>
          editTranslationAsync(
            sql,
            MANAGER,
            { action: "save", input: { ...target, baseRevision: 0, value: "New" } },
            200,
            "test",
          ),
        "conflict",
      );
      checkEqual(stale.current?.value, "Hallo");
      await editTranslationAsync(sql, MANAGER, { action: "delete", input: target }, 200, "test");
      const deleted = await rejected(
        () => editTranslationAsync(sql, MANAGER, { action: "approve", input: target }, 250, "test"),
        "conflict",
      );
      checkEqual(deleted.current, null);
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            MANAGER,
            { action: "approve", input: { ...target, baseRevision: 0 } },
            250,
            "test",
          ),
        "bad_request",
      );
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            MANAGER,
            { action: "unapprove", input: { ...target, baseRevision: 0 } },
            250,
            "test",
          ),
        "bad_request",
      );
    },
  },
  {
    name: "permissions, active strings, translatable kinds and project languages gate edits",
    async run(sql) {
      const target = await seed(sql);
      await rejected(
        () =>
          editTranslationAsync(sql, ANONYMOUS, { action: "delete", input: target }, 200, "test"),
        "unauthorized",
      );
      await rejected(
        () => editTranslationAsync(sql, USER, { action: "delete", input: target }, 200, "test"),
        "forbidden",
      );
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            { type: "token", tokenId: 7 },
            { action: "delete", input: target },
            200,
            "test",
          ),
        "forbidden",
      );
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            MANAGER,
            { action: "delete", input: { ...target, language: "fr" } },
            200,
            "test",
          ),
        "forbidden",
      );
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            SYSTEM,
            { action: "delete", input: { ...target, language: "es" } },
            200,
            "test",
          ),
        "bad_request",
      );
      const [number] = await sql.read([
        { sql: "SELECT id FROM strings WHERE display_key = 'number'" },
      ]);
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            SYSTEM,
            {
              action: "save",
              input: { ...target, id: Number(number[0].id), value: "number", baseRevision: 0 },
            },
            200,
            "test",
          ),
        "bad_request",
      );
      await change(sql, [{ sql: "UPDATE files SET active = 0 WHERE path = 'common.json'" }]);
      await rejected(
        () => editTranslationAsync(sql, MANAGER, { action: "delete", input: target }, 200, "test"),
        "not_found",
      );
    },
  },
  {
    name: "save and approval rerun QA against current English without changing failed translations",
    async run(sql) {
      const target = await seed(sql);
      await change(sql, [
        {
          sql: "UPDATE strings SET source = '\"Hello {{name}}\"' WHERE id = ?",
          params: [target.id],
        },
      ]);
      await rejected(
        () => editTranslationAsync(sql, MANAGER, { action: "approve", input: target }, 200, "test"),
        "qa_failed",
      );
      await rejected(
        () =>
          editTranslationAsync(
            sql,
            MANAGER,
            { action: "save", input: { ...target, value: "Hallo" } },
            200,
            "test",
          ),
        "qa_failed",
      );
      const [rows] = await sql.read([
        {
          sql: "SELECT value, colour, revision FROM translations WHERE string_id = ? AND language = 'de'",
          params: [target.id],
        },
      ]);
      checkEqual(rows, [{ value: '"Hallo"', colour: "green", revision: 2 }]);
    },
  },
  {
    name: "a blue edit supersedes all pending suggestions with history in the same revision",
    async run(sql) {
      const target = await seed(sql);
      const sent = await suggestAsync(
        sql,
        USER,
        { ...target, kind: "correction", value: "Alternative" },
        150,
        "test",
      );
      const approval = await suggestAsync(
        sql,
        SYSTEM,
        { ...target, kind: "approval" },
        150,
        "test",
      );
      const result = await editTranslationAsync(
        sql,
        MANAGER,
        { action: "save", input: { ...target, value: "Edited" } },
        200,
        "test",
      );
      checkEqual(result.translation?.revision, 6);
      const [suggestions, history] = await sql.read([
        {
          sql: "SELECT id, status, reviewer_id FROM suggestions WHERE string_id = ? ORDER BY id",
          params: [target.id],
        },
        {
          sql: "SELECT detail, actor_id FROM history WHERE event = 'suggestion_superseded' ORDER BY id",
        },
      ]);
      checkEqual(suggestions, [
        { id: sent.id, status: "superseded", reviewer_id: null },
        { id: approval.id, status: "superseded", reviewer_id: null },
      ]);
      checkEqual(
        history.map((row) => [JSON.parse(String(row.detail)).suggestionId, row.actor_id]),
        [
          [sent.id, 2],
          [approval.id, 2],
        ],
      );
    },
  },
  {
    name: "deletion supersedes approvals and LLM proposals while leaving people's corrections pending",
    async run(sql) {
      const target = await seed(sql);
      const correction = await suggestAsync(
        sql,
        USER,
        { ...target, kind: "correction", value: "Alternative" },
        150,
        "test",
      );
      const approval = await suggestAsync(
        sql,
        SYSTEM,
        { ...target, kind: "approval" },
        150,
        "test",
      );
      const llm = await suggestAsync(
        sql,
        SYSTEM,
        { ...target, kind: "correction", value: "LLM text" },
        150,
        "test",
      );
      await change(sql, [
        { sql: "UPDATE suggestions SET kind = 'llm' WHERE id = ?", params: [llm.id] },
      ]);
      await editTranslationAsync(sql, MANAGER, { action: "delete", input: target }, 200, "test");
      const [rows] = await sql.read([
        {
          sql: "SELECT id, status FROM suggestions WHERE string_id = ? ORDER BY id",
          params: [target.id],
        },
      ]);
      checkEqual(rows, [
        { id: correction.id, status: "pending" },
        { id: approval.id, status: "superseded" },
        { id: llm.id, status: "superseded" },
      ]);
    },
  },
  {
    name: "concurrent translation changes conflict and new pending suggestions are included on retry",
    async run(sql) {
      const target = await seed(sql);
      const edited = conflict(sql, () =>
        editTranslationAsync(
          sql,
          MANAGER,
          { action: "save", input: { ...target, value: "Winner" } },
          150,
          "test",
        ).then(() => {}),
      );
      const failure = await rejected(
        () =>
          editTranslationAsync(edited, MANAGER, { action: "delete", input: target }, 200, "test"),
        "conflict",
      );
      checkEqual(failure.current?.value, "Winner");
      const raced = conflict(sql, () =>
        suggestAsync(
          sql,
          USER,
          { ...target, baseRevision: 4, kind: "correction", value: "Pending" },
          160,
          "test",
        ).then(() => {}),
      );
      const result = await editTranslationAsync(
        raced,
        MANAGER,
        { action: "save", input: { ...target, baseRevision: 4, value: "Edited" } },
        200,
        "test",
      );
      checkEqual(result.translation?.value, "Edited");
      const [rows] = await sql.read([
        { sql: "SELECT status FROM suggestions WHERE string_id = ?", params: [target.id] },
      ]);
      checkEqual(rows, [{ status: "superseded" }]);
    },
  },
  {
    name: "changed QA facts and grants are rechecked after conflicts",
    async run(sql) {
      const target = await seed(sql);
      const qa = conflict(sql, () =>
        change(sql, [
          { sql: "UPDATE strings SET max_length = 1 WHERE id = ?", params: [target.id] },
        ]),
      );
      await rejected(
        () =>
          editTranslationAsync(
            qa,
            MANAGER,
            { action: "save", input: { ...target, value: "Long" } },
            200,
            "test",
          ),
        "qa_failed",
      );
      const restricted = conflict(sql, () =>
        change(sql, [{ sql: "UPDATE users SET languages = '[\"fr\"]' WHERE id = 2" }]),
      );
      await rejected(
        () =>
          editTranslationAsync(
            restricted,
            MANAGER,
            { action: "delete", input: target },
            200,
            "test",
          ),
        "forbidden",
      );
    },
  },
  {
    name: "failed commit rolls back the translation, superseding, history and revision",
    async run(sql) {
      const target = await seed(sql);
      await suggestAsync(
        sql,
        USER,
        { ...target, kind: "correction", value: "Pending" },
        150,
        "test",
      );
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await editTranslationAsync(
          broken,
          MANAGER,
          { action: "save", input: { ...target, value: "Edited" } },
          200,
          "test",
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [translation, suggestions, history, revision] = await sql.read([
        {
          sql: "SELECT value, colour FROM translations WHERE string_id = ? AND language = 'de'",
          params: [target.id],
        },
        { sql: "SELECT status FROM suggestions WHERE string_id = ?", params: [target.id] },
        {
          sql: "SELECT event FROM history WHERE event IN ('translation_saved', 'suggestion_superseded')",
        },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translation, [{ value: '"Hallo"', colour: "green" }]);
      checkEqual(suggestions, [{ status: "pending" }]);
      checkEqual(history, []);
      checkEqual(revision, [{ value: "4" }]);
    },
  },
  {
    name: "validated methods enforce input and permission precedence and preserve system authorship",
    async run(sql) {
      const target = await seed(sql);
      const methods = asyncWriteMethods({ sql, clock: () => 200 });
      await rejected(
        () => methods.saveTranslation(USER, { ...target, value: 3 } as never),
        "forbidden",
      );
      await rejected(
        () => methods.saveTranslation(MANAGER, { ...target, value: 3 } as never),
        "validation_failed",
      );
      const result = await methods.saveTranslation(SYSTEM, { ...target, value: "System text" });
      checkEqual(
        [
          result.translation?.author.type,
          result.translation?.author.name,
          result.translation?.approver,
        ],
        ["system", "System", null],
      );
      const approved = { ...target, baseRevision: result.translation!.revision };
      const green = await methods.unapproveTranslation(SYSTEM, approved);
      const blue = await methods.approveTranslation(SYSTEM, {
        ...target,
        baseRevision: green.translation!.revision,
      });
      checkEqual(
        await methods.deleteTranslation(SYSTEM, {
          ...target,
          baseRevision: blue.translation!.revision,
        }),
        { translation: null },
      );
    },
  },
];
