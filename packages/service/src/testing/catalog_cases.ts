// SPDX-License-Identifier: MIT
import { sha256Hex } from "@quaso/core";
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import { exportFilesAsync } from "../export.ts";
import { listGlossaryAsync } from "../glossary.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

async function seedGlossary(sql: Sql): Promise<number> {
  await seedStringReads(sql);
  await sql.commit(2, [
    {
      sql: `INSERT INTO glossary_terms
    (id, term, term_normalized, language, kind, translation, case_sensitive, note, created_by, created_at, updated_at) VALUES
    (1, 'Hello', 'hello', NULL, 'keep', NULL, 0, 'Brand', 1, 100, 100),
    (2, 'Hello', 'hello', 'de', 'translate', 'Hallo', 0, 'Greeting', 2, 100, 101),
    (3, 'Hello', 'hello', 'fr', 'translate', 'Bonjour', 0, '', NULL, 100, 100),
    (4, 'HERO', 'hero', NULL, 'keep', NULL, 1, '日本語', NULL, 100, 100),
    (5, 'hero', 'hero', 'de', 'translate', 'Held', 0, '', 1, 100, 100)`,
    },
  ]);
  const [rows] = await sql.read([{ sql: "SELECT id FROM strings WHERE display_key = 'title'" }]);
  return Number(rows[0].id);
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

export const CATALOG_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "glossary selects global and canonical-language terms with creator metadata",
    async run(sql) {
      await seedGlossary(sql);
      const glossary = await listGlossaryAsync(sql, { language: "DE" });
      checkEqual(
        glossary.terms.map((term) => term.id),
        [1, 2, 4, 5],
      );
      checkEqual(glossary.terms[1], {
        id: 2,
        term: "Hello",
        language: "de",
        kind: "translate",
        translation: "Hallo",
        caseSensitive: false,
        note: "Greeting",
        createdBy: { type: "user", id: 2, name: "Reviewer", avatarUrl: null },
        createdAt: 100,
        updatedAt: 101,
      });
      checkEqual(
        (await listGlossaryAsync(sql, {})).terms.map((term) => term.id),
        [1, 2, 3, 4, 5],
      );
      checkEqual(
        (await listGlossaryAsync(sql, { q: " ＨＡＬＬＯ " })).terms.map((term) => term.id),
        [2],
      );
      checkEqual(
        (await listGlossaryAsync(sql, { q: "日本語" })).terms.map((term) => term.id),
        [4],
      );
    },
  },
  {
    name: "glossary string matching honors whole terms and case sensitivity",
    async run(sql) {
      const id = await seedGlossary(sql);
      checkEqual(
        (await listGlossaryAsync(sql, { language: "de", stringId: id })).terms.map(
          (term) => term.id,
        ),
        [1, 2],
      );
      await sql.commit(3, [
        {
          sql: "UPDATE strings SET source = ? WHERE id = ?",
          params: [JSON.stringify("hero superhero"), id],
        },
      ]);
      checkEqual(
        (await listGlossaryAsync(sql, { stringId: id })).terms.map((term) => term.id),
        [5],
      );
      await sql.commit(4, [
        {
          sql: "UPDATE strings SET source = ? WHERE id = ?",
          params: [JSON.stringify({ one: "HERO", other: "Hello" }), id],
        },
      ]);
      checkEqual(
        (await listGlossaryAsync(sql, { stringId: id, language: "de" })).terms.map(
          (term) => term.id,
        ),
        [1, 2, 4, 5],
      );
    },
  },
  {
    name: "glossary rejects missing and hidden sources and snapshots creator names",
    async run(sql) {
      const id = await seedGlossary(sql);
      await rejected(() => listGlossaryAsync(sql, { stringId: 999 }), "not_found");
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(3, [
            { sql: "UPDATE users SET display_name = 'Changed'" },
            { sql: "UPDATE strings SET active = 0 WHERE id = ?", params: [id] },
          ]);
          return rows;
        },
      };
      const glossary = await listGlossaryAsync(changing, { stringId: id, language: "de" });
      checkEqual([reads, glossary.terms[0].createdBy?.name], [1, "Ada"]);
      await rejected(() => listGlossaryAsync(sql, { stringId: id }), "not_found");
    },
  },
  {
    name: "exports are byte-stable, ordered and hashed with accepted outdated translations",
    async run(sql) {
      await seedStringReads(sql);
      const exported = await exportFilesAsync(sql, {}, "test");
      checkEqual(
        [exported.revision, exported.sourceLanguage, exported.schemaVersion],
        [2, "en", 1],
      );
      checkEqual(
        exported.files.map((file) => `${file.language}/${file.path}`),
        ["de/Menus/main.json", "de/common.json", "fr/Menus/main.json", "fr/common.json"],
      );
      checkEqual(
        exported.files.map((file) => file.sha256),
        exported.files.map((file) => sha256Hex(file.content)),
      );
      const common = JSON.parse(exported.files[1].content);
      checkEqual(
        [common.title, common.play, common.ref, common.number],
        ["Hallo", "Spielen", "$t(title)", 3],
      );
      checkEqual(JSON.parse(exported.files[0].content), { start: "Start" });
      checkEqual(await exportFilesAsync(sql, {}, "test"), exported);
    },
  },
  {
    name: "export selection canonicalizes and deduplicates and rejects unknown files and languages",
    async run(sql) {
      await seedStringReads(sql);
      const selected = await exportFilesAsync(
        sql,
        { languages: ["DE", "de"], files: ["common.json", "common.json"] },
        "test",
      );
      checkEqual(
        selected.files.map((file) => [file.language, file.path]),
        [["de", "common.json"]],
      );
      await rejected(() => exportFilesAsync(sql, { languages: ["en"] }, "test"), "bad_request");
      await rejected(() => exportFilesAsync(sql, { languages: ["es"] }, "test"), "bad_request");
      await rejected(
        () => exportFilesAsync(sql, { files: ["menus/main.json"] }, "test"),
        "not_found",
      );
      checkEqual((await exportFilesAsync(sql, { files: [] }, "test")).files, []);
      checkEqual((await exportFilesAsync(sql, { languages: [] }, "test")).files, []);
    },
  },
  {
    name: "hidden rows and pending suggestions are excluded from exports",
    async run(sql) {
      await seedStringReads(sql);
      await sql.commit(2, [
        { sql: "UPDATE files SET active = 0 WHERE path = 'Menus/main.json'" },
        { sql: "UPDATE strings SET active = 0 WHERE display_key = 'play'" },
        {
          sql: "INSERT INTO suggestions (string_id, language, kind, value, source_hash, base_revision, author_type, created_at) SELECT id, 'de', 'correction', '\"Unaccepted\"', source_hash, 3, 'system', 100 FROM strings WHERE display_key = 'title'",
        },
      ]);
      const exported = await exportFilesAsync(sql, { languages: ["de"] }, "test");
      checkEqual(
        exported.files.map((file) => file.path),
        ["common.json"],
      );
      const common = JSON.parse(exported.files[0].content);
      checkEqual(common.title, "Hallo");
      checkEqual(common.play, undefined);
    },
  },
  {
    name: "a concurrent export change cannot mix the returned revision and bytes",
    async run(sql) {
      await seedStringReads(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(2, [
            { sql: "UPDATE translations SET value = '\"Changed\"' WHERE language = 'de'" },
          ]);
          return rows;
        },
      };
      const exported = await exportFilesAsync(
        changing,
        { languages: ["de"], files: ["common.json"] },
        "test",
      );
      checkEqual(
        [reads, exported.revision, JSON.parse(exported.files[0].content).title],
        [1, 2, "Hallo"],
      );
      const current = await exportFilesAsync(
        sql,
        { languages: ["de"], files: ["common.json"] },
        "test",
      );
      checkEqual([current.revision, JSON.parse(current.files[0].content).title], [3, "Changed"]);
    },
  },
  {
    name: "exports preserve tabs, CRLF and trailing newlines",
    async run(sql) {
      const content = '{\r\n\t"title": "Hello"\r\n}\r\n';
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        { files: [{ path: "a.json", repoPath: "a.json", content }], languages: ["de"] },
        { model: "test", clock: () => 100, llmAvailable: false },
      );
      const result = await exportFilesAsync(sql, {}, "test");
      checkEqual(result.files[0].content, content);
      checkEqual(result.files[0].sha256, sha256Hex(content));
    },
  },
  {
    name: "exports expand plural forms and obey stored overrides",
    async run(sql) {
      await uploadAsync(
        sql,
        SYSTEM_AUTHOR,
        {
          files: [
            {
              path: "a.json",
              repoPath: "a.json",
              content: '{"coins_one":"{{count}} coin","coins_other":"{{count}} coins"}',
            },
          ],
          languages: ["pl"],
        },
        { model: "test", clock: () => 100, llmAvailable: false },
      );
      await sql.commit(1, [
        {
          sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type, revision, search_text, created_at, updated_at)
        SELECT id, 'pl', ?, 'green', source_hash, 'system', 2, '', 100, 100 FROM strings`,
          params: [JSON.stringify({ one: "{{count}} moneta", other: "{{count}} monet" })],
        },
      ]);
      const first = await exportFilesAsync(sql, {}, "test");
      checkEqual(JSON.parse(first.files[0].content), {
        coins_one: "{{count}} moneta",
        coins_few: "{{count}} coins",
        coins_many: "{{count}} coins",
        coins_other: "{{count}} monet",
      });
      await sql.commit(2, [
        {
          sql: "UPDATE languages SET plural_override = ? WHERE tag = 'pl'",
          params: [JSON.stringify({ cardinal: ["one", "other"] })],
        },
      ]);
      const overridden = await exportFilesAsync(sql, {}, "test");
      checkEqual(JSON.parse(overridden.files[0].content), {
        coins_one: "{{count}} moneta",
        coins_other: "{{count}} monet",
      });
    },
  },
  {
    name: "empty stores have no glossary terms or exported files",
    async run(sql) {
      checkEqual(await listGlossaryAsync(sql, {}), { terms: [] });
      checkEqual((await exportFilesAsync(sql, {}, "test")).files, []);
    },
  },
];
