// SPDX-License-Identifier: MIT
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import { getProjectAsync } from "../project.ts";
import { getStatusAsync, listFilesAsync } from "../status.ts";
import type { Sql } from "../ports.ts";
import { uploadAsync } from "../upload.ts";
import { check, checkEqual } from "./assert.ts";

const MODEL = "test";

async function seed(sql: Sql): Promise<void> {
  await uploadAsync(
    sql,
    SYSTEM_AUTHOR,
    {
      files: [
        {
          path: "a.json",
          repoPath: "src/locales/en/a.json",
          content: '{"hello":"Hello","morning":"Good morning","ref":"$t(hello)","number":3}',
        },
        { path: "b.json", repoPath: "src/locales/en/b.json", content: '{"bye":"Bye"}' },
      ],
      languages: ["de", "ar"],
    },
    { model: MODEL, clock: () => 100, llmAvailable: false },
  );
  await sql.commit(1, [
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type,
      revision, qa_errors, search_text, created_at, updated_at)
      SELECT id, 'de', '"Hallo"', 'blue', source_hash, 'system', 2, 0, 'hallo', 100, 100
      FROM strings WHERE display_key = 'hello'`,
    },
    {
      sql: `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type,
      revision, qa_errors, search_text, created_at, updated_at)
      SELECT id, 'de', '"Morgen"', 'green', 'old', 'system', 2, 1, 'morgen', 100, 100
      FROM strings WHERE display_key = 'morning'`,
    },
    {
      sql: `INSERT INTO suggestions (string_id, language, kind, source_hash, base_revision, author_type, created_at)
      SELECT id, 'de', 'approval', source_hash, 2, 'system', 100 FROM strings WHERE display_key = 'hello'`,
    },
    {
      sql: `INSERT INTO suggestions (string_id, language, kind, source_hash, base_revision, author_type, created_at)
      SELECT id, 'de', 'approval', source_hash, 2, 'system', 101 FROM strings WHERE display_key = 'hello'`,
    },
    {
      sql: "INSERT INTO users (id, display_name, role, created_at, deleted_at) VALUES (1, 'Member', 'contributor', 100, NULL), (2, 'Visitor', 'none', 100, NULL), (3, 'Deleted', 'manager', 100, 101)",
    },
  ]);
}

export const PROGRESS_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "source listings are language-independent and carry repository paths and upload metadata",
    async run(sql) {
      checkEqual(await listFilesAsync(sql, MODEL), { files: [] });
      await seed(sql);
      const sources = await listFilesAsync(sql, MODEL);
      checkEqual(sources, {
        files: [
          {
            id: 1,
            path: "a.json",
            repoPath: "src/locales/en/a.json",
            strings: 2,
            words: 3,
            updatedAt: 100,
            revision: 1,
          },
          {
            id: 2,
            path: "b.json",
            repoPath: "src/locales/en/b.json",
            strings: 1,
            words: 1,
            updatedAt: 100,
            revision: 1,
          },
        ],
      });
      const translated = await listFilesAsync(sql, MODEL, "de");
      check(translated.language !== undefined);
      checkEqual(
        translated.files.map((file) => [file.path, file.repoPath, file.blue]),
        [
          ["a.json", "src/locales/en/a.json", 1],
          ["b.json", "src/locales/en/b.json", 0],
        ],
      );
    },
  },
  {
    name: "source last-change metadata advances only for changed uploads and includes empty files",
    async run(sql) {
      const files = [
        { path: "a.json", repoPath: "src/en/a.json", content: '{"hello":"Hello"}' },
        { path: "empty.json", repoPath: "src/en/empty.json", content: '{"version":1}' },
      ];
      const upload = (at: number, wanted = files, dryRun = false) =>
        uploadAsync(
          sql,
          SYSTEM_AUTHOR,
          { files: wanted, partial: true, dryRun },
          { model: MODEL, clock: () => at, llmAvailable: false },
        );
      await upload(100);
      const initial = await listFilesAsync(sql, MODEL);
      check(initial.language === undefined);
      checkEqual(
        initial.files.map((file) => [
          file.path,
          file.strings,
          file.words,
          file.updatedAt,
          file.revision,
        ]),
        [
          ["a.json", 1, 1, 100, 1],
          ["empty.json", 0, 0, 100, 1],
        ],
      );
      await upload(200);
      await sql.commit(1, [
        { sql: "UPDATE files SET context = 'Context', updated_at = 250 WHERE id = 1" },
      ]);
      checkEqual(await listFilesAsync(sql, MODEL), initial);
      const changed = [{ ...files[0], content: '{"hello":"Good morning"}' }];
      await upload(300, changed, true);
      checkEqual(await listFilesAsync(sql, MODEL), initial);
      await upload(400, changed);
      const latest = await listFilesAsync(sql, MODEL);
      check(latest.language === undefined);
      checkEqual(
        latest.files.map((file) => [
          file.path,
          file.strings,
          file.words,
          file.updatedAt,
          file.revision,
        ]),
        [
          ["a.json", 1, 2, 400, 3],
          ["empty.json", 0, 0, 100, 1],
        ],
      );
      await upload(500, changed);
      checkEqual(await listFilesAsync(sql, MODEL), latest);
      await sql.commit(3, [{ sql: "UPDATE files SET active = 0 WHERE id = 2" }]);
      checkEqual(
        (await listFilesAsync(sql, MODEL)).files.map((file) => file.path),
        ["a.json"],
      );
    },
  },
  {
    name: "an empty project returns defaults and zero counts",
    async run(sql) {
      const project = await getProjectAsync(sql, MODEL);
      checkEqual(
        [project.name, project.sourceLanguage, project.revision, project.llmAvailable],
        ["Untitled project", "en", 0, false],
      );
      checkEqual(project.details, {
        strings: 0,
        words: 0,
        files: 0,
        members: 0,
        lastActivity: null,
      });
      checkEqual(project.referenceLanguages, []);
      checkEqual(await getStatusAsync(sql, MODEL), {
        revision: 0,
        sourceLanguage: "en",
        languages: [],
      });
    },
  },
  {
    name: "project and status count active translatable strings and translation states",
    async run(sql) {
      await seed(sql);
      const project = await getProjectAsync(sql, MODEL, true);
      checkEqual(project.details, {
        strings: 3,
        words: 4,
        files: 2,
        members: 1,
        lastActivity: 100,
      });
      checkEqual([project.revision, project.llmAvailable], [2, true]);
      const status = await getStatusAsync(sql, MODEL, "DE");
      const de = status.languages[0];
      checkEqual(
        [status.revision, status.sourceLanguage, de.tag, de.direction],
        [2, "en", "de", "ltr"],
      );
      checkEqual(
        {
          strings: de.strings,
          words: de.words,
          untranslated: de.untranslated,
          blue: de.blue,
          green: de.green,
          outdated: de.outdated,
          pending: de.pending,
          qa: de.qa,
          wordsLeft: de.wordsLeft,
          translatedPercent: de.translatedPercent,
          proofreadPercent: de.proofreadPercent,
        },
        {
          strings: 3,
          words: 4,
          untranslated: 1,
          blue: 1,
          green: 1,
          outdated: 1,
          pending: 1,
          qa: 1,
          wordsLeft: 1,
          translatedPercent: 75,
          proofreadPercent: 25,
        },
      );
      checkEqual(
        de.files.map((file) => [file.path, file.strings, file.words, file.blue]),
        [
          ["a.json", 2, 3, 1],
          ["b.json", 1, 1, 0],
        ],
      );
      checkEqual(await listFilesAsync(sql, MODEL, "DE"), { language: "de", files: de.files });
      checkEqual(
        project.languages.map((entry) => entry.tag),
        ["ar", "de"],
      );
      checkEqual(project.languages[0].direction, "rtl");
    },
  },
  {
    name: "hidden files and strings leave progress without stale cached counts",
    async run(sql) {
      await seed(sql);
      await getStatusAsync(sql, MODEL);
      await sql.commit(2, [
        { sql: "UPDATE files SET active = 0 WHERE path = 'b.json'" },
        { sql: "UPDATE strings SET active = 0 WHERE display_key = 'morning'" },
      ]);
      const status = await getStatusAsync(sql, MODEL, "de");
      checkEqual(
        [
          status.revision,
          status.languages[0].strings,
          status.languages[0].words,
          status.languages[0].qa,
          status.languages[0].outdated,
        ],
        [3, 1, 1, 0, 0],
      );
      checkEqual(
        status.languages[0].files.map((file) => file.path),
        ["a.json"],
      );
      checkEqual((await getProjectAsync(sql, MODEL)).details.strings, 1);
    },
  },
  {
    name: "zero-word percentages fall back to string counts",
    async run(sql) {
      await seed(sql);
      await sql.commit(2, [{ sql: "UPDATE strings SET words = 0" }]);
      const de = (await getStatusAsync(sql, MODEL, "de")).languages[0];
      checkEqual([de.words, de.translatedPercent, de.proofreadPercent], [0, 66, 33]);
    },
  },
  {
    name: "a concurrent change after the read cannot mix revisions and progress",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const snapshotSql: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(2, [{ sql: "UPDATE strings SET words = 10" }]);
          return rows;
        },
      };
      const project = await getProjectAsync(snapshotSql, MODEL);
      checkEqual([reads, project.revision, project.details.words], [1, 2, 4]);
      const current = await getProjectAsync(sql, MODEL);
      checkEqual([current.revision, current.details.words], [3, 30]);
    },
  },
  {
    name: "stored settings and plural overrides shape project and status",
    async run(sql) {
      await seed(sql);
      await sql.commit(2, [
        {
          sql: "INSERT INTO settings (id, data) VALUES (1, ?)",
          params: [
            JSON.stringify({
              name: "Wayfarer",
              sourceLanguage: "fr",
              llm: { context: { otherLanguages: ["de"] } },
            }),
          ],
        },
        {
          sql: "UPDATE languages SET plural_override = ? WHERE tag = 'de'",
          params: [JSON.stringify({ cardinal: ["other"] })],
        },
      ]);
      const project = await getProjectAsync(sql, MODEL);
      checkEqual(
        [project.name, project.sourceLanguage, project.sourceLanguageName],
        ["Wayfarer", "fr", "French"],
      );
      const status = await getStatusAsync(sql, MODEL, "de");
      checkEqual(project.referenceLanguages, ["de"]);
      checkEqual(status.sourceLanguage, "fr");
      checkEqual(status.languages[0].plural.cardinal, ["other"]);
    },
  },
  {
    name: "unknown and invalid language tags are not found",
    async run(sql) {
      let failure: unknown;
      try {
        await listFilesAsync(sql, MODEL, "invalid tag");
      } catch (error) {
        failure = error;
      }
      check(failure instanceof ServiceError);
      checkEqual(failure.code, "not_found");
      let unknown: unknown;
      try {
        await getStatusAsync(sql, MODEL, "fr");
      } catch (error) {
        unknown = error;
      }
      check(unknown instanceof ServiceError);
      checkEqual(unknown.code, "not_found");
    },
  },
];
