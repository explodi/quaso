// SPDX-License-Identifier: MIT
import { SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import { cancelJobAsync } from "../jobs/jobs.ts";
import { recordRequestAsync, getUsageAsync, type RequestRecord } from "../jobs/usage.ts";
import { readJobWork } from "../jobs/work.ts";
import { writeBatchAsync, type BatchSuccess } from "../jobs/write.ts";
import type { Sql } from "../ports.ts";
import { check, checkEqual } from "./assert.ts";
import { seedJobWork } from "./job_work_cases.ts";

const OPTIONS = { now: 200, model: "test" };
const RECORD: RequestRecord = {
  jobId: 1,
  language: "de",
  fileId: 1,
  provider: "test",
  model: "test",
  strings: 3,
  usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 2 },
  durationMs: 30,
  outcome: "ok",
  error: null,
};
async function seed(sql: Sql) {
  await seedJobWork(sql);
  await sql.commit(1, [
    { sql: "DELETE FROM job_items" },
    { sql: "UPDATE jobs SET total = 3 WHERE id = 1" },
  ]);
}
async function batch(sql: Sql) {
  const work = await readJobWork(
    sql,
    0,
    "website",
    { languages: ["de"], strings: [1, 3, 5] },
    { batchSize: 25, updateOutdated: true, proposeForProofread: true },
  );
  return work.batches[0];
}
function successes(): Map<number, BatchSuccess> {
  return new Map([
    [1, { value: "Hallo", requestId: 1, model: "test" }],
    [3, { value: "Neu", requestId: 1, model: "test" }],
    [5, { value: "Vorschlag", requestId: 1, model: "test" }],
  ]);
}
function race(sql: Sql, change: () => Promise<unknown>): Sql {
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

export const JOB_RESULT_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "green results, blue proposals, history and progress commit at one revision",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const result = await writeBatchAsync(
        sql,
        SYSTEM,
        1,
        selected,
        successes(),
        new Map(),
        OPTIONS,
      );
      checkEqual(
        [...result!],
        [
          [1, "translated"],
          [3, "translated"],
          [5, "proposed"],
        ],
      );
      const [translations, suggestions, history, job, items, revision] = await sql.read([
        {
          sql: "SELECT string_id, value, colour, revision FROM translations WHERE language = 'de' AND string_id IN (1,3,5) ORDER BY string_id",
        },
        {
          sql: "SELECT id, string_id, base_revision, source_hash, value FROM suggestions WHERE string_id = 5",
        },
        { sql: "SELECT event, actor_type, actor_label FROM history ORDER BY id" },
        { sql: "SELECT total, done, translated, proposed, failed, skipped FROM jobs WHERE id = 1" },
        { sql: "SELECT string_id, outcome FROM job_items WHERE job_id = 1 ORDER BY string_id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(translations, [
        { string_id: 1, value: '"Hallo"', colour: "green", revision: 3 },
        { string_id: 3, value: '"Neu"', colour: "green", revision: 3 },
        { string_id: 5, value: '"old blue"', colour: "blue", revision: 5 },
      ]);
      checkEqual(suggestions, [
        { id: 2, string_id: 5, base_revision: 5, source_hash: "new", value: '"Vorschlag"' },
      ]);
      checkEqual(history, [
        { event: "translation_llm", actor_type: "llm", actor_label: "test" },
        { event: "translation_llm", actor_type: "llm", actor_label: "test" },
        { event: "suggestion_created", actor_type: "llm", actor_label: "test" },
      ]);
      checkEqual(job, [{ total: 3, done: 3, translated: 2, proposed: 1, failed: 0, skipped: 0 }]);
      checkEqual(items, [
        { string_id: 1, outcome: "translated" },
        { string_id: 3, outcome: "translated" },
        { string_id: 5, outcome: "proposed" },
      ]);
      checkEqual(revision, [{ value: "3" }]);
    },
  },
  {
    name: "already processed pairs are no-ops and never count progress twice",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const original = await writeBatchAsync(
        sql,
        SYSTEM,
        1,
        selected,
        successes(),
        new Map(),
        OPTIONS,
      );
      const readOnly: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(
        [
          ...(await writeBatchAsync(
            readOnly,
            SYSTEM,
            1,
            selected,
            successes(),
            new Map(),
            OPTIONS,
          ))!,
        ],
        [...original!],
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT done FROM jobs WHERE id = 1" },
          { sql: "SELECT COUNT(*) AS n FROM history" },
        ]),
        [[{ done: 3 }], [{ n: 3 }]],
      );
    },
  },
  {
    name: "QA failure stays local to its pair while valid results and provider failures commit",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      await sql.commit(2, [{ sql: "UPDATE strings SET max_length = 1 WHERE id = 1" }]);
      const passed = successes();
      passed.delete(5);
      const result = await writeBatchAsync(
        sql,
        SYSTEM,
        1,
        selected,
        passed,
        new Map([[5, "Provider refused"]]),
        OPTIONS,
      );
      checkEqual(
        [...result!],
        [
          [1, "failed"],
          [3, "translated"],
          [5, "failed"],
        ],
      );
      const [failed, job, history] = await sql.read([
        { sql: "SELECT string_id, reason FROM llm_failures ORDER BY string_id" },
        { sql: "SELECT done, failed, translated, failures FROM jobs WHERE id = 1" },
        { sql: "SELECT string_id FROM history" },
      ]);
      checkEqual(
        failed.map((row) => row.string_id),
        [1, 5],
      );
      checkEqual(failed[1].reason, "Provider refused");
      checkEqual(
        [job[0].done, job[0].failed, job[0].translated, JSON.parse(String(job[0].failures)).length],
        [3, 2, 1, 2],
      );
      checkEqual(history, [{ string_id: 3 }]);
    },
  },
  {
    name: "changed source, translation and hidden string results are skipped",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      await sql.commit(2, [
        { sql: "UPDATE strings SET source_hash = 'changed' WHERE id = 1" },
        { sql: "UPDATE translations SET revision = 10 WHERE string_id = 3 AND language = 'de'" },
        { sql: "UPDATE strings SET active = 0 WHERE id = 5" },
      ]);
      checkEqual(
        [...(await writeBatchAsync(sql, SYSTEM, 1, selected, successes(), new Map(), OPTIONS))!],
        [
          [1, "skipped"],
          [3, "skipped"],
          [5, "skipped"],
        ],
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT done, skipped FROM jobs WHERE id = 1" },
          { sql: "SELECT id FROM history" },
        ]),
        [[{ done: 3, skipped: 3 }], []],
      );
    },
  },
  {
    name: "hidden files and strings changed to nontranslatable kinds cannot receive results",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      await sql.commit(2, [
        { sql: "UPDATE strings SET kind = 'literal' WHERE id = 5" },
        { sql: "UPDATE strings SET kind = 'reference' WHERE id = 3" },
      ]);
      checkEqual(
        [
          ...(await writeBatchAsync(
            sql,
            SYSTEM,
            1,
            selected,
            new Map([
              [3, successes().get(3)!],
              [5, successes().get(5)!],
            ]),
            new Map(),
            OPTIONS,
          ))!,
        ],
        [
          [3, "skipped"],
          [5, "skipped"],
        ],
      );
      await sql.commit(4, [{ sql: "UPDATE files SET active = 0 WHERE id = 1" }]);
      checkEqual(
        [
          ...(await writeBatchAsync(
            sql,
            SYSTEM,
            1,
            selected,
            new Map([[1, successes().get(1)!]]),
            new Map(),
            OPTIONS,
          ))!,
        ],
        [
          [1, "skipped"],
          [3, "skipped"],
          [5, "skipped"],
        ],
      );
      checkEqual(await sql.read([{ sql: "SELECT id FROM history" }]), [[]]);
    },
  },
  {
    name: "large failed batches use bounded pair inserts and keep only the latest 200 failures",
    async run(sql) {
      await seed(sql);
      const ids = Array.from({ length: 26 }, (_, index) => index + 100);
      const prior = Array.from({ length: 200 }, (_, index) => ({
        stringId: index,
        language: "de",
        file: "old.json",
        key: String(index),
        reason: "Previous",
      }));
      await sql.commit(2, [
        {
          sql: "UPDATE jobs SET done = 200, failed = 200, total = 200, failures = ? WHERE id = 1",
          params: [JSON.stringify(prior)],
        },
        {
          sql: `INSERT INTO strings (id, file_id, key, key_path, display_key, kind, source, source_hash, search_text, position, created_at, updated_at)
          SELECT value, 1, CAST(value AS TEXT), '[]', CAST(value AS TEXT), 'text', '"Hello"', 'new', '', value, 100, 100 FROM json_each(?)`,
          params: [JSON.stringify(ids)],
        },
      ]);
      const work = await readJobWork(
        sql,
        0,
        "website",
        { languages: ["de"], strings: ids },
        { batchSize: 100, updateOutdated: true, proposeForProofread: true },
      );
      const result = await writeBatchAsync(
        sql,
        SYSTEM,
        1,
        work.batches[0],
        new Map(),
        new Map(ids.map((id) => [id, "Provider failed"])),
        OPTIONS,
      );
      checkEqual(result?.size, 26);
      const [job, items] = await sql.read([
        { sql: "SELECT done, total, failed, failures FROM jobs WHERE id = 1" },
        { sql: "SELECT COUNT(*) AS n FROM job_items WHERE job_id = 1" },
      ]);
      const failures = JSON.parse(String(job[0].failures));
      checkEqual(
        [
          job[0].done,
          job[0].total,
          job[0].failed,
          failures.length,
          failures[0].stringId,
          failures.at(-1).stringId,
          items,
        ],
        [226, 226, 226, 200, 26, 125, [{ n: 26 }]],
      );
    },
  },
  {
    name: "missing and terminal jobs drop results and unprocessed empty batches skip commits",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const readOnly: Sql = {
        ...sql,
        commit: async () => {
          throw new Error("Unexpected commit");
        },
      };
      checkEqual(
        [...(await writeBatchAsync(readOnly, SYSTEM, 1, selected, new Map(), new Map(), OPTIONS))!],
        [],
      );
      checkEqual(
        await writeBatchAsync(readOnly, SYSTEM, 999, selected, successes(), new Map(), OPTIONS),
        null,
      );
      await sql.commit(2, [{ sql: "UPDATE jobs SET status = 'done' WHERE id = 1" }]);
      checkEqual(
        await writeBatchAsync(readOnly, SYSTEM, 1, selected, successes(), new Map(), OPTIONS),
        null,
      );
      await sql.commit(3, [{ sql: "UPDATE jobs SET status = 'failed' WHERE id = 1" }]);
      checkEqual(
        await writeBatchAsync(readOnly, SYSTEM, 1, selected, successes(), new Map(), OPTIONS),
        null,
      );
    },
  },
  {
    name: "removed languages and disabled proofread proposals skip successful results",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      await sql.commit(2, [
        { sql: 'INSERT INTO settings VALUES (1, \'{"llm":{"proposeForProofread":false}}\')' },
      ]);
      checkEqual(
        [
          ...(await writeBatchAsync(
            sql,
            SYSTEM,
            1,
            selected,
            new Map([[5, successes().get(5)!]]),
            new Map(),
            OPTIONS,
          ))!,
        ],
        [[5, "skipped"]],
      );
      await sql.commit(4, [{ sql: "DELETE FROM languages WHERE tag = 'de'" }]);
      checkEqual(
        [
          ...(await writeBatchAsync(
            sql,
            SYSTEM,
            1,
            selected,
            new Map([[1, successes().get(1)!]]),
            new Map(),
            OPTIONS,
          ))!,
        ],
        [
          [1, "skipped"],
          [5, "skipped"],
        ],
      );
    },
  },
  {
    name: "a new LLM proposal supersedes only earlier pending LLM proposals with history",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      await sql.commit(2, [
        {
          sql: "INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision, author_type, created_at) VALUES (5, 'de', 'llm', '\"Earlier\"', 'old', 5, 'llm', 100), (5, 'de', 'correction', '\"Person\"', 'old', 5, 'user', 100)",
        },
      ]);
      await writeBatchAsync(
        sql,
        SYSTEM,
        1,
        selected,
        new Map([[5, successes().get(5)!]]),
        new Map(),
        OPTIONS,
      );
      const [suggestions, history] = await sql.read([
        { sql: "SELECT id, status FROM suggestions WHERE string_id = 5 ORDER BY id" },
        { sql: "SELECT event, detail FROM history ORDER BY id" },
      ]);
      checkEqual(suggestions, [
        { id: 2, status: "superseded" },
        { id: 3, status: "pending" },
        { id: 4, status: "pending" },
      ]);
      checkEqual(history[0].event, "suggestion_superseded");
      checkEqual(JSON.parse(String(history[0].detail)), { suggestionId: 2, supersededBy: 4 });
      checkEqual(history[1].event, "suggestion_created");
    },
  },
  {
    name: "partial batches leave pairs with neither outcome unprocessed and preserve paused work",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      await sql.commit(2, [{ sql: "UPDATE jobs SET status = 'paused' WHERE id = 1" }]);
      checkEqual(
        [
          ...(await writeBatchAsync(
            sql,
            SYSTEM,
            1,
            selected,
            new Map([[3, successes().get(3)!]]),
            new Map(),
            OPTIONS,
          ))!,
        ],
        [[3, "translated"]],
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT status, done FROM jobs WHERE id = 1" },
          { sql: "SELECT string_id FROM job_items WHERE job_id = 1" },
        ]),
        [[{ status: "paused", done: 1 }], [{ string_id: 3 }]],
      );
    },
  },
  {
    name: "cancellation during commit drops all results without progress or history",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const raced = race(sql, () => cancelJobAsync(sql, SYSTEM, 1, 150));
      checkEqual(
        await writeBatchAsync(raced, SYSTEM, 1, selected, successes(), new Map(), OPTIONS),
        null,
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT done FROM jobs WHERE id = 1" },
          { sql: "SELECT id FROM history" },
          { sql: "SELECT job_id FROM job_items" },
        ]),
        [[{ done: 0 }], [], []],
      );
    },
  },
  {
    name: "competing progress refreshes counters and competing translation wins on retry",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const raced = race(sql, () =>
        sql.commit(2, [
          { sql: "UPDATE jobs SET done = 2, translated = 2 WHERE id = 1" },
          {
            sql: "UPDATE translations SET colour = 'blue', revision = 20 WHERE string_id = 3 AND language = 'de'",
          },
        ]),
      );
      checkEqual(
        [...(await writeBatchAsync(raced, SYSTEM, 1, selected, successes(), new Map(), OPTIONS))!],
        [
          [1, "translated"],
          [3, "skipped"],
          [5, "proposed"],
        ],
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT done, total, translated, proposed, skipped FROM jobs WHERE id = 1" },
        ]),
        [[{ done: 5, total: 5, translated: 3, proposed: 1, skipped: 1 }]],
      );
    },
  },
  {
    name: "failed batch commit rolls back translations, proposals, history, progress and revision",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await writeBatchAsync(broken, SYSTEM, 1, selected, successes(), new Map(), OPTIONS);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(
        await sql.read([
          { sql: "SELECT done FROM jobs WHERE id = 1" },
          { sql: "SELECT string_id FROM translations WHERE string_id = 1" },
          { sql: "SELECT id FROM suggestions WHERE string_id = 5" },
          { sql: "SELECT id FROM history" },
          { sql: "SELECT job_id FROM job_items" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[{ done: 0 }], [], [], [], [], [{ value: "2" }]],
      );
    },
  },
  {
    name: "request usage and job tokens commit together and stay visible after cancellation",
    async run(sql) {
      await seed(sql);
      await cancelJobAsync(sql, SYSTEM, 1, 150);
      checkEqual(
        await recordRequestAsync(
          sql,
          SYSTEM,
          {
            ...RECORD,
            usage: { inputTokens: 10.4, outputTokens: 5.6, thinkingTokens: 2.2 },
            durationMs: -5,
          },
          200,
        ),
        1,
      );
      checkEqual(
        await sql.read([
          {
            sql: "SELECT input_tokens, output_tokens, thinking_tokens, duration_ms FROM llm_requests",
          },
          {
            sql: "SELECT status, input_tokens, output_tokens, thinking_tokens FROM jobs WHERE id = 1",
          },
        ]),
        [
          [{ input_tokens: 10, output_tokens: 6, thinking_tokens: 2, duration_ms: 0 }],
          [{ status: "cancelled", input_tokens: 10, output_tokens: 6, thinking_tokens: 2 }],
        ],
      );
      const usage = await getUsageAsync(sql, SYSTEM, { period: "month" }, 18, 200);
      checkEqual([usage.budget.usedThisMonth, usage.budget.paused], [18, true]);
    },
  },
  {
    name: "request ID races refresh without losing accumulated job usage",
    async run(sql) {
      await seed(sql);
      const raced = race(sql, () => recordRequestAsync(sql, SYSTEM, RECORD, 150));
      checkEqual(
        await recordRequestAsync(
          raced,
          SYSTEM,
          { ...RECORD, language: null, strings: 0, outcome: "failed", error: "context failed" },
          200,
        ),
        2,
      );
      checkEqual(
        await sql.read([
          { sql: "SELECT id, language, outcome FROM llm_requests ORDER BY id" },
          { sql: "SELECT input_tokens, output_tokens, thinking_tokens FROM jobs WHERE id = 1" },
        ]),
        [
          [
            { id: 1, language: "de", outcome: "ok" },
            { id: 2, language: null, outcome: "failed" },
          ],
          [{ input_tokens: 20, output_tokens: 10, thinking_tokens: 4 }],
        ],
      );
    },
  },
  {
    name: "request failures roll back usage and job tokens and non-system callers cannot write",
    async run(sql) {
      await seed(sql);
      const selected = await batch(sql);
      const person: Actor = { type: "user", userId: 1 };
      await rejected(() => recordRequestAsync(sql, person, RECORD, 200), "forbidden");
      await rejected(
        () => writeBatchAsync(sql, person, 1, selected, successes(), new Map(), OPTIONS),
        "forbidden",
      );
      const broken: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]),
      };
      let failure: unknown;
      try {
        await recordRequestAsync(broken, SYSTEM, RECORD, 200);
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      checkEqual(
        await sql.read([
          { sql: "SELECT id FROM llm_requests" },
          { sql: "SELECT input_tokens FROM jobs WHERE id = 1" },
          { sql: "SELECT value FROM meta WHERE key = 'revision'" },
        ]),
        [[], [{ input_tokens: 0 }], [{ value: "2" }]],
      );
    },
  },
];
