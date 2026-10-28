// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { createJobAsync } from "../jobs/jobs.ts";
import { promptContextAsync } from "../jobs/prompts.ts";
import { readJobWork } from "../jobs/work.ts";
import { createFakeTranslator } from "../llm/fake.ts";
import { defaultSettings } from "../settings.ts";
import type { Sql } from "../ports.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobWork } from "./job_work_cases.ts";

const MANAGER: Actor = { type: "user", userId: 2 };
const TOKEN: Actor = { type: "token", tokenId: 7 };
const OPTIONS = { llmAvailable: true, monthlyTokenBudget: null, now: 200, model: "test" };
async function seed(sql: Sql) {
  await seedJobWork(sql);
  await sql.commit(1, [
    {
      sql: "INSERT INTO users (id, display_name, role, languages, created_at) VALUES (1, 'Admin', 'administrator', NULL, 100), (2, 'Manager', 'manager', '[\"de\"]', 100), (3, 'Contributor', 'contributor', NULL, 100)",
    },
    {
      sql: "INSERT INTO api_tokens (id, name, scope, secret_hash, prefix, created_at) VALUES (7, 'CI', 'upload', 'hash7', 'qso_', 100), (8, 'Read', 'read', 'hash8', 'qso_', 100)",
    },
  ]);
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
function raceCommit(sql: Sql, change: () => Promise<unknown>): Sql {
  let first = true;
  return {
    ...sql,
    async commit(revision, statements) {
      if (first) {
        first = false;
        await change();
      }
      return sql.commit(revision, statements);
    },
  };
}
export const JOB_CREATION_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "estimates and queued job summaries name outdated translations excluded by scope",
    async run(sql) {
      await seed(sql);
      const scope = { languages: ["de"], strings: [3, 5], outdated: false };
      const dry = await createJobAsync(sql, TOKEN, { ...scope, dryRun: true }, OPTIONS);
      check(dry.estimate !== null);
      checkEqual(
        [dry.estimate.outdated, dry.estimate.outdatedLeft, dry.estimate.strings],
        [2, 2, 0],
      );
      const created = await createJobAsync(sql, TOKEN, scope, OPTIONS);
      check(created.job !== null);
      checkEqual(created.job.outdatedLeft, 2);
      const included = await createJobAsync(
        sql,
        TOKEN,
        { ...scope, outdated: true, dryRun: true },
        OPTIONS,
      );
      check(included.estimate !== null);
      checkEqual(
        [included.estimate.outdated, included.estimate.outdatedLeft, included.estimate.strings],
        [2, undefined, 2],
      );
    },
  },
  {
    name: "job, creator metadata and queued activity commit together at one revision",
    async run(sql) {
      await seed(sql);
      const result = await createJobAsync(
        sql,
        TOKEN,
        {
          languages: ["DE", "de"],
          files: ["a.json", "a.json"],
          strings: [1, 1],
          instruction: "  Short  ",
          model: " custom-model ",
        },
        OPTIONS,
      );
      check(result.job !== null);
      checkEqual(
        [
          result.estimate,
          result.job.id,
          result.job.status,
          result.job.priority,
          result.job.createdBy.name,
          result.job.progress.total,
        ],
        [null, 2, "queued", "string", "CI", 1],
      );
      checkEqual(result.job.scope, {
        languages: ["de"],
        files: ["a.json"],
        strings: [1],
        instruction: "Short",
        model: "custom-model",
      });
      const [jobs, activity, revision] = await sql.read([
        {
          sql: "SELECT source, actor_type, actor_id, actor_label, created_at FROM jobs WHERE id = 2",
        },
        { sql: "SELECT summary, detail, actor_type, actor_id FROM activity WHERE type = 'job'" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(jobs, [
        { source: "cli", actor_type: "token", actor_id: 7, actor_label: "CI", created_at: 200 },
      ]);
      checkEqual(activity[0].summary, "Translation job 2 queued: 1 string in de of a.json");
      checkEqual(JSON.parse(String(activity[0].detail)), {
        jobId: 2,
        total: 1,
        scope: result.job.scope,
      });
      checkEqual(
        [activity[0].actor_type, activity[0].actor_id, revision],
        ["token", 7, [{ value: "3" }]],
      );
    },
  },
  {
    name: "empty jobs finish immediately with both activities and one guarded commit",
    async run(sql) {
      await seed(sql);
      const result = await createJobAsync(sql, SYSTEM, { languages: [] }, OPTIONS);
      check(result.job !== null);
      checkEqual(
        [result.job.status, result.job.finishedAt, result.job.startedAt, result.job.progress.total],
        ["done", 200, null, 0],
      );
      const [activity, revision] = await sql.read([
        { sql: "SELECT summary FROM activity ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(activity, [
        { summary: "Translation job 2 queued: 0 strings in " },
        { summary: "Translation job 2 finished: 0 translated" },
      ]);
      checkEqual(revision, [{ value: "3" }]);
    },
  },
  {
    name: "language-limited managers default to their languages and cannot name others",
    async run(sql) {
      await seed(sql);
      const result = await createJobAsync(sql, MANAGER, {}, OPTIONS);
      checkEqual(
        [result.job?.scope, result.job?.progress.total, result.job?.createdBy.name],
        [{ languages: ["de"] }, 5, "Manager"],
      );
      await rejected(
        () => createJobAsync(sql, MANAGER, { languages: ["fr"] }, OPTIONS),
        "forbidden",
      );
      await sql.commit(3, [{ sql: "UPDATE users SET languages = '[]' WHERE id = 2" }]);
      await rejected(() => createJobAsync(sql, MANAGER, {}, OPTIONS), "forbidden");
    },
  },
  {
    name: "scope, provider and permission gates leave no new jobs",
    async run(sql) {
      await seed(sql);
      await rejected(() => createJobAsync(sql, ANONYMOUS, {}, OPTIONS), "unauthorized");
      await rejected(
        () => createJobAsync(sql, { type: "user", userId: 3 }, {}, OPTIONS),
        "forbidden",
      );
      await rejected(
        () => createJobAsync(sql, { type: "token", tokenId: 8 }, {}, OPTIONS),
        "forbidden",
      );
      await rejected(
        () => createJobAsync(sql, SYSTEM, {}, { ...OPTIONS, llmAvailable: false }),
        "llm_unavailable",
      );
      await rejected(
        () => createJobAsync(sql, SYSTEM, { languages: ["missing"] }, OPTIONS),
        "bad_request",
      );
      await rejected(
        () => createJobAsync(sql, SYSTEM, { files: ["hidden.json"] }, OPTIONS),
        "bad_request",
      );
      await rejected(() => createJobAsync(sql, SYSTEM, { strings: [999] }, OPTIONS), "not_found");
      await rejected(
        () => createJobAsync(sql, SYSTEM, { model: "bad/model" }, OPTIONS),
        "bad_request",
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT id FROM jobs" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ id: 1 }], [{ value: "2" }]],
      );
    },
  },
  {
    name: "dry runs count words and rendered requests without writes even when budget is exhausted",
    async run(sql) {
      await seed(sql);
      const settings = defaultSettings("test");
      settings.llm.batchSize = 2;
      await sql.commit(2, [
        { sql: "INSERT INTO settings VALUES (1, ?)", params: [JSON.stringify(settings)] },
      ]);
      const readOnly: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      const result = await createJobAsync(
        readOnly,
        MANAGER,
        { dryRun: true },
        { ...OPTIONS, monthlyTokenBudget: 0 },
      );
      check(result.estimate !== null);
      checkEqual(
        [
          result.job,
          result.estimate.strings,
          result.estimate.words,
          result.estimate.requests,
          result.estimate.languages,
        ],
        [null, 5, 5, 3, [{ language: "de", strings: 5, words: 5 }]],
      );
      check(result.estimate.estimatedTokens.input > 0);
      checkEqual(result.estimate.files, [
        { file: "a.json", strings: 4, words: 4 },
        { file: "b.json", strings: 1, words: 1 },
      ]);
      check(result.estimate.estimatedTokens.output > 0);
      await rejected(
        () => createJobAsync(sql, MANAGER, {}, { ...OPTIONS, monthlyTokenBudget: 0 }),
        "budget_exceeded",
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT id FROM jobs" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ id: 1 }], [{ value: "3" }]],
      );
    },
  },
  {
    name: "file estimates sum languages and batches while respecting selected files and scope",
    async run(sql) {
      await seed(sql);
      const settings = defaultSettings("test");
      settings.llm.batchSize = 2;
      await sql.commit(2, [
        { sql: "INSERT INTO settings VALUES (1, ?)", params: [JSON.stringify(settings)] },
        { sql: "UPDATE strings SET words = 3 WHERE id = 1" },
      ]);
      const all = await createJobAsync(sql, SYSTEM, { dryRun: true }, OPTIONS);
      checkEqual(all.estimate?.files, [
        { file: "a.json", strings: 10, words: 14 },
        { file: "b.json", strings: 2, words: 2 },
      ]);
      checkEqual([all.estimate?.strings, all.estimate?.words], [12, 16]);
      const selected = await createJobAsync(
        sql,
        SYSTEM,
        { dryRun: true, languages: ["de"], files: ["a.json"], outdated: false },
        OPTIONS,
      );
      checkEqual(selected.estimate?.files, [{ file: "a.json", strings: 1, words: 3 }]);
      const empty = await createJobAsync(sql, SYSTEM, { dryRun: true, languages: [] }, OPTIONS);
      checkEqual(empty.estimate?.files, []);
    },
  },
  {
    name: "creation retries refresh counts, creator names and generated job IDs",
    async run(sql) {
      await seed(sql);
      const raced = raceCommit(sql, async () => {
        await sql.commit(2, [
          { sql: "UPDATE strings SET active = 0 WHERE id = 1" },
          { sql: "UPDATE api_tokens SET name = 'Renamed CI' WHERE id = 7" },
        ]);
        await createJobAsync(sql, SYSTEM, { languages: [] }, OPTIONS);
      });
      const result = await createJobAsync(raced, TOKEN, { languages: ["de"] }, OPTIONS);
      checkEqual(
        [result.job?.id, result.job?.progress.total, result.job?.createdBy.name],
        [3, 4, "Renamed CI"],
      );
      const [activity] = await sql.read([
        { sql: "SELECT COUNT(*) AS n FROM activity WHERE json_extract(detail, '$.jobId') = 3" },
      ]);
      checkEqual(activity, [{ n: 1 }]);
    },
  },
  {
    name: "concurrent revocation and demotion invalidate creation authority",
    async run(sql) {
      await seed(sql);
      const revoked = raceCommit(sql, () =>
        sql.commit(2, [{ sql: "UPDATE api_tokens SET revoked_at = 150 WHERE id = 7" }]),
      );
      await rejected(() => createJobAsync(revoked, TOKEN, {}, OPTIONS), "forbidden");
      const demoted = raceCommit(sql, () =>
        sql.commit(3, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 2" }]),
      );
      await rejected(() => createJobAsync(demoted, MANAGER, {}, OPTIONS), "forbidden");
      checkEqual(await sql.read([{ sql: "SELECT id FROM jobs" }]), [[{ id: 1 }]]);
    },
  },
  {
    name: "scope and monthly budget changes invalidate a planned creation",
    async run(sql) {
      await seed(sql);
      const removed = raceCommit(sql, () =>
        sql.commit(2, [{ sql: "UPDATE files SET active = 0 WHERE id = 1" }]),
      );
      await rejected(
        () => createJobAsync(removed, SYSTEM, { files: ["a.json"] }, OPTIONS),
        "bad_request",
      );
      const exhausted = raceCommit(sql, () =>
        sql.commit(3, [
          {
            sql: "INSERT INTO llm_requests (provider, model, strings, input_tokens, output_tokens, thinking_tokens, duration_ms, outcome, created_at) VALUES ('test', 'test', 1, 5, 4, 1, 0, 'ok', 200)",
          },
        ]),
      );
      await rejected(
        () => createJobAsync(exhausted, SYSTEM, {}, { ...OPTIONS, monthlyTokenBudget: 10 }),
        "budget_exceeded",
      );
    },
  },
  {
    name: "failed creation rolls back job, activities and revision without logs",
    async run(sql) {
      await seed(sql);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      const logs: unknown[] = [];
      let failure: unknown;
      try {
        await createJobAsync(
          broken,
          SYSTEM,
          { languages: [] },
          {
            ...OPTIONS,
            logger: {
              info: (...args) => logs.push(args),
              debug: () => {},
              warn: () => {},
              error: () => {},
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(logs, []);
      checkEqual(
        await sql.read([
          { sql: "SELECT id FROM jobs" },
          { sql: "SELECT id FROM activity" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ id: 1 }], [], [{ value: "2" }]],
      );
    },
  },
  {
    name: "validated creation calls the host only after queued commit and validates permissions first",
    async run(sql) {
      await seed(sql);
      const notifications: unknown[] = [];
      const methods = asyncWriteMethods({
        sql,
        provider: createFakeTranslator(),
        clock: () => 200,
        afterCreateJob: async (job) => {
          notifications.push(
            await sql.read([{ sql: "SELECT status FROM jobs WHERE id = ?", params: [job.id] }]),
          );
        },
      });
      await rejected(() => methods.createJob(ANONYMOUS, { strings: [0] }), "unauthorized");
      await rejected(() => methods.createJob(SYSTEM, { strings: [0] }), "validation_failed");
      await methods.createJob(SYSTEM, { languages: ["de"] });
      await methods.createJob(SYSTEM, { languages: [] });
      await methods.createJob(SYSTEM, { dryRun: true });
      checkEqual(notifications, [[[{ status: "queued" }]]]);
    },
  },
  {
    name: "a dry run doesn't start over when the project changes during its prompt reads",
    async run(sql) {
      await seed(sql);
      const before = await createJobAsync(sql, MANAGER, { dryRun: true }, OPTIONS);
      let promptReads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (!statements[0].sql.includes("generated_context")) return rows;
          promptReads++;
          if (promptReads === 1) {
            // A running job's write, landing while the estimate reads.
            const [[{ revision }]] = await sql.read([
              { sql: "SELECT CAST(value AS INTEGER) AS revision FROM meta WHERE key = 'revision'" },
            ]);
            await sql.commit(Number(revision), [
              { sql: "UPDATE users SET display_name = display_name WHERE id = 2" },
            ]);
          }
          return rows;
        },
      };
      const during = await createJobAsync(changing, MANAGER, { dryRun: true }, OPTIONS);
      checkEqual(during, before);
      checkEqual(promptReads, before.estimate?.requests);
    },
  },
  {
    name: "continuous commit conflicts stop after four attempts without queued activity",
    async run(sql) {
      await seed(sql);
      let attempts = 0;
      const changing: Sql = {
        ...sql,
        async commit(revision, statements) {
          attempts++;
          await sql.commit(revision, [
            { sql: "UPDATE files SET updated_at = updated_at + 1 WHERE id = 1" },
          ]);
          return sql.commit(revision, statements);
        },
      };
      await rejected(() => createJobAsync(changing, SYSTEM, {}, OPTIONS), "unavailable");
      checkEqual(attempts, 4);
      checkEqual(
        await sql.read([{ sql: "SELECT id FROM jobs" }, { sql: "SELECT id FROM activity" }]),
        [[{ id: 1 }], []],
      );
    },
  },
  {
    name: "prompt reads preserve written context, proofread other languages, neighbours, references and glossary",
    async run(sql) {
      await seed(sql);
      await sql.commit(2, [
        {
          sql: `UPDATE strings SET source = '"Hello $t(2) $t(b:7) $t(missing)"', description = 'Hint' WHERE id = 1`,
        },
        {
          sql: "UPDATE files SET context = 'Written', generated_context = 'Generated' WHERE id = 1",
        },
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at) VALUES (1, 'fr', '"French"', 'blue', 'new', 'user', 2, '', 100, 100), (7, 'de', '"Remote"', 'blue', 'new', 'user', 2, '', 100, 100)`,
        },
        {
          sql: "INSERT INTO glossary_terms (term, term_normalized, language, kind, translation, case_sensitive, note, created_at, updated_at) VALUES ('Hello', 'hello', 'de', 'translate', 'Hallo', 0, 'Greeting', 100, 100)",
        },
      ]);
      const settings = defaultSettings("test");
      settings.llm.context.otherLanguages = ["de", "fr", "missing"];
      const facts = {
        sourceLanguage: "en",
        syntax: settings.syntax,
        languages: new Map([
          [
            "de",
            {
              tag: "de",
              instructions: "German instruction",
              pluralOverride: undefined,
              createdAt: 100,
            },
          ],
          ["fr", { tag: "fr", instructions: "", pluralOverride: undefined, createdAt: 100 }],
        ]),
      };
      const work = await readJobWork(
        sql,
        0,
        "website",
        { languages: ["de"], strings: [1] },
        settings.llm,
      );
      const context = await promptContextAsync(sql, settings, facts, work.batches[0], " Custom ");
      checkEqual(
        [context.fileContext, context.languageInstructions, context.customInstruction],
        ["Written", "German instruction", "Custom"],
      );
      checkEqual(context.otherLanguages, [
        { id: 1, language: "fr", value: "French", proofread: true },
      ]);
      checkEqual(
        context.neighbours.map((row) => row.key),
        ["2", "3", "4"],
      );
      // Fresh green, old green and fresh blue: only the proofread one is shown.
      checkEqual(
        context.neighbours.map((row) => row.translation),
        [null, null, "fresh blue"],
      );
      checkEqual(
        [...context.references],
        [
          ["$t(2)", { english: "Hello", translation: "fresh green" }],
          ["$t(b:7)", { english: "Hello", translation: "Remote" }],
          ["$t(missing)", { english: null, translation: null }],
        ],
      );
      check(context.glossary.includes("Hallo"));
      checkEqual(context.identicalStrings, [
        { english: "Hello", translation: "fresh blue", proofread: true },
        { english: "Hello", translation: "Remote", proofread: true },
      ]);
      await sql.commit(3, [
        { sql: "UPDATE translations SET colour = 'green' WHERE string_id = 1 AND language = 'fr'" },
      ]);
      const unproofread = await promptContextAsync(sql, settings, facts, work.batches[0], "");
      checkEqual(unproofread.otherLanguages, []);
      settings.llm.context.fileContext = false;
      settings.llm.context.glossary = false;
      settings.llm.context.identicalStrings = false;
      settings.llm.neighbours = 0;
      await sql.commit(4, [{ sql: "UPDATE files SET context = '' WHERE id = 1" }]);
      const disabled = await promptContextAsync(sql, settings, facts, work.batches[0], "");
      checkEqual(
        [disabled.fileContext, disabled.glossary, disabled.identicalStrings, disabled.neighbours],
        ["", "", [], []],
      );
      settings.llm.context.fileContext = true;
      checkEqual(
        (await promptContextAsync(sql, settings, facts, work.batches[0], "")).fileContext,
        "Generated",
      );
    },
  },
];
