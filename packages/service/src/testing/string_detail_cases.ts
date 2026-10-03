// SPDX-License-Identifier: MIT
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { getStringAsync } from "../strings.ts";
import { uploadAsync } from "../upload.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const DAY = 86_400_000;
const OPTIONS = { model: "test", clock: () => 40 * DAY };

async function seed(sql: Sql): Promise<number> {
  await seedStringReads(sql);
  await uploadAsync(
    sql,
    SYSTEM_AUTHOR,
    {
      partial: true,
      files: [
        {
          path: "guide.json",
          repoPath: "guide.json",
          content: JSON.stringify({
            guide: "Hello {{name}} $t(common:title) $t(common:title) $t(coins) $t(missing)",
            coins_one: "{{count}} coin",
            coins_other: "{{count}} coins",
          }),
        },
      ],
    },
    { model: "test", clock: () => 100, llmAvailable: false },
  );
  await sql.commit(3, [
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, author_id, approver_id, revision, search_text, created_at, updated_at)
      SELECT id, 'de', '"Hallo"', 'blue', source_hash, 'user', 1, 2, 4, 'hallo', 100, 100 FROM strings WHERE display_key = 'guide'`,
    },
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, author_id, revision, search_text, created_at, updated_at)
      SELECT id, 'fr', '"Bonjour"', 'green', source_hash, 'token', 7, 4, 'bonjour', 100, 100 FROM strings WHERE display_key = 'guide'`,
    },
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, author_id, reviewer_id, created_at, reviewed_at)
      SELECT 100, id, 'de', 'approval', NULL, source_hash, 4, 'pending', 'user', 1, NULL, 100, NULL FROM strings WHERE display_key = 'guide'`,
    },
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, author_id, reviewer_id, created_at, reviewed_at)
      SELECT 101, id, 'de', 'correction', '"Vorschlag"', source_hash, 4, 'rejected', 'user', 1, 2, 100, ? FROM strings WHERE display_key = 'guide'`,
      params: [10 * DAY],
    },
    {
      sql: `INSERT INTO suggestions (id, string_id, language, kind, value, source_hash, base_revision, status, author_type, created_at, reviewed_at)
      SELECT 102, id, 'de', 'correction', '"Old"', source_hash, 4, 'rejected', 'system', 100, ? FROM strings WHERE display_key = 'guide'`,
      params: [10 * DAY - 1],
    },
    {
      sql: "INSERT INTO glossary_terms (id, term, term_normalized, language, kind, translation, created_by, created_at, updated_at) VALUES (1, 'Hello', 'hello', 'de', 'translate', 'Hallo', 1, 100, 100), (2, 'Unrelated', 'unrelated', NULL, 'keep', NULL, 2, 100, 100)",
    },
    {
      sql: "INSERT INTO llm_failures (string_id, language, reason, created_at) SELECT id, 'de', 'Refused', 100 FROM strings WHERE display_key = 'guide'",
    },
  ]);
  const [rows] = await sql.read([{ sql: "SELECT id FROM strings WHERE display_key = 'guide'" }]);
  return Number(rows[0].id);
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

export const STRING_DETAIL_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "detail includes identities, other languages, deduplicated references and checks",
    async run(sql) {
      const id = await seed(sql);
      const detail = await getStringAsync(sql, id, "DE", OPTIONS);
      checkEqual(
        [detail.language, detail.file, detail.key, detail.translation?.value, detail.llmFailure],
        ["de", "guide.json", "guide", "Hallo", "Refused"],
      );
      checkEqual(
        [detail.translation?.author.name, detail.translation?.approver?.name],
        ["Ada", "Reviewer"],
      );
      checkEqual(
        detail.otherLanguages.map((entry) => [
          entry.language,
          entry.translation?.value,
          entry.translation?.author.name,
        ]),
        [["fr", "Bonjour", "CI"]],
      );
      checkEqual(detail.references, [
        { raw: "$t(common:title)", english: "Hello" },
        { raw: "$t(coins)", english: "{{count}} coins" },
        { raw: "$t(missing)", english: null },
      ]);
      check(detail.checks.some((entry) => entry.check === "placeholder_missing"));
      checkEqual(
        detail.glossary.map((term) => [term.term, term.createdBy?.name]),
        [["Hello", "Ada"]],
      );
    },
  },
  {
    name: "review cutoff includes its boundary and pending approvals have no value checks",
    async run(sql) {
      const id = await seed(sql);
      const detail = await getStringAsync(sql, id, "de", OPTIONS);
      checkEqual(
        detail.suggestions.map((entry) => entry.id),
        [101, 100],
      );
      checkEqual(detail.suggestions[0].reviewer?.name, "Reviewer");
      checkEqual([detail.suggestions[1].value, detail.suggestions[1].checks], [null, []]);
      checkEqual(detail.suggestions[0].current?.value, "Hallo");
      check(detail.suggestions[0].checks.length > 0);
    },
  },
  {
    name: "hidden reference targets resolve to null without hiding the requested string",
    async run(sql) {
      const id = await seed(sql);
      await sql.commit(4, [{ sql: "UPDATE files SET active = 0 WHERE path = 'common.json'" }]);
      checkEqual((await getStringAsync(sql, id, "de", OPTIONS)).references[0], {
        raw: "$t(common:title)",
        english: null,
      });
    },
  },
  {
    name: "a change between preparation and detail rereads the new reference targets",
    async run(sql) {
      const id = await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(4, [
              {
                sql: "UPDATE strings SET source = ? WHERE id = ?",
                params: [JSON.stringify("Hello $t(common:play)"), id],
              },
            ]);
          return rows;
        },
      };
      const detail = await getStringAsync(changing, id, "de", OPTIONS);
      checkEqual(reads, 4);
      checkEqual(detail.source, "Hello $t(common:play)");
      checkEqual(detail.references, [{ raw: "$t(common:play)", english: "Play" }]);
    },
  },
  {
    name: "repeated changes stop after four attempts with an unavailable error",
    async run(sql) {
      const id = await seed(sql);
      let reads = 0;
      let revision = 4;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          revision = await sql.commit(revision, [
            { sql: "UPDATE strings SET words = words + 1 WHERE id = ?", params: [id] },
          ]);
          return rows;
        },
      };
      const failure = await rejected(() => getStringAsync(changing, id, "de", OPTIONS));
      checkEqual([reads, failure.code, failure.status], [8, "unavailable", 503]);
    },
  },
  {
    name: "hidden, literal and missing strings and unknown languages are not found",
    async run(sql) {
      const id = await seed(sql);
      checkEqual((await rejected(() => getStringAsync(sql, id, "es", OPTIONS))).code, "not_found");
      checkEqual(
        (await rejected(() => getStringAsync(sql, 9999, "de", OPTIONS))).code,
        "not_found",
      );
      const [literal] = await sql.read([
        { sql: "SELECT id FROM strings WHERE kind = 'literal' LIMIT 1" },
      ]);
      checkEqual(
        (await rejected(() => getStringAsync(sql, Number(literal[0].id), "de", OPTIONS))).code,
        "not_found",
      );
      await sql.commit(4, [{ sql: "UPDATE strings SET active = 0 WHERE id = ?", params: [id] }]);
      checkEqual((await rejected(() => getStringAsync(sql, id, "de", OPTIONS))).code, "not_found");
    },
  },
];
