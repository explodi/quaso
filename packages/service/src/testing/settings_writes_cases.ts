// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { SYSTEM_AUTHOR } from "../actors.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { defaultSettings } from "../settings.ts";
import { updateSettingsAsync, addProjectLanguageAsync } from "../settings_writes.ts";
import { uploadAsync } from "../upload.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const OPTIONS = { model: "test", now: 200 };
const EXTRAS = { models: ["model-a"], llmAvailable: true };

async function seed(sql: Sql) {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    { sql: "UPDATE strings SET source = '\"Play {{name}}\"' WHERE id = 2" },
  ]);
}

async function empty(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (1, 'Ada', 'administrator', 100)",
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

async function qa(sql: Sql) {
  const [rows] = await sql.read([
    {
      sql: "SELECT qa_errors, qa_warnings FROM translations WHERE string_id = 2 AND language = 'de'",
    },
  ]);
  return rows[0];
}

export const SETTINGS_WRITE_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "retention defaults, bounds and independent updates are persisted",
    async run(sql) {
      await seed(sql);
      const defaults = await updateSettingsAsync(sql, ADMIN, {}, OPTIONS, EXTRAS);
      checkEqual(
        [defaults.settings.fileHistoryDays, defaults.settings.backupRetentionDays],
        [90, 30],
      );
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { fileHistoryDays: -1 }, OPTIONS, EXTRAS),
        "validation_failed",
      );
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { backupRetentionDays: 0 }, OPTIONS, EXTRAS),
        "validation_failed",
      );
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { fileHistoryDays: 1.5 }, OPTIONS, EXTRAS),
        "validation_failed",
      );
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { backupRetentionDays: 36501 }, OPTIONS, EXTRAS),
        "validation_failed",
      );
      await updateSettingsAsync(sql, ADMIN, { fileHistoryDays: 0 }, OPTIONS, EXTRAS);
      const saved = await updateSettingsAsync(
        sql,
        ADMIN,
        { backupRetentionDays: 7 },
        OPTIONS,
        EXTRAS,
      );
      checkEqual([saved.settings.fileHistoryDays, saved.settings.backupRetentionDays], [0, 7]);
    },
  },
  {
    name: "unchanged defaults return a complete snapshot without storing or committing",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const reading: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          return sql.read(statements);
        },
        async commit() {
          throw new Error("Unexpected commit");
        },
      };
      const result = await updateSettingsAsync(reading, ADMIN, {}, OPTIONS, EXTRAS);
      checkEqual(
        [reads, result.settings, result.models, result.llmAvailable],
        [1, defaultSettings("test"), ["model-a"], true],
      );
      checkEqual(
        result.languages.map((language) => language.tag),
        ["de", "fr"],
      );
      checkEqual(
        result.files.map((file) => file.path),
        ["Menus/main.json", "common.json"],
      );
      const [stored] = await sql.read([{ sql: "SELECT data FROM settings" }]);
      checkEqual(stored, []);
    },
  },
  {
    name: "nested settings merge and canonical language context survive storage",
    async run(sql) {
      await seed(sql);
      const result = await updateSettingsAsync(
        sql,
        ADMIN,
        {
          name: "Game",
          llm: { batchSize: 10, context: { otherLanguages: ["PT-br"], fileContext: false } },
        },
        OPTIONS,
        EXTRAS,
      );
      checkEqual(
        [result.settings.name, result.settings.llm.batchSize, result.settings.llm.context],
        [
          "Game",
          10,
          { ...defaultSettings("test").llm.context, otherLanguages: ["pt-BR"], fileContext: false },
        ],
      );
      const [stored] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
      checkEqual(JSON.parse(stored[0].data as string), result.settings);
    },
  },
  {
    name: "syntax changes recompute QA without changing translation values or revisions",
    async run(sql) {
      await seed(sql);
      await updateSettingsAsync(
        sql,
        ADMIN,
        { syntax: { prefix: "%", suffix: "%" } },
        OPTIONS,
        EXTRAS,
      );
      checkEqual(await qa(sql), { qa_errors: 0, qa_warnings: 0 });
      await updateSettingsAsync(
        sql,
        ADMIN,
        { syntax: { prefix: "{{", suffix: "}}" } },
        OPTIONS,
        EXTRAS,
      );
      checkEqual(await qa(sql), { qa_errors: 1, qa_warnings: 0 });
      const [translation] = await sql.read([
        { sql: "SELECT value, revision FROM translations WHERE string_id = 2 AND language = 'de'" },
      ]);
      checkEqual(translation, [{ value: '"Spielen"', revision: 2 }]);
    },
  },
  {
    name: "prompt and model validation reject invalid patches without saving",
    async run(sql) {
      await seed(sql);
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { name: "" }, OPTIONS, EXTRAS),
        "validation_failed",
      );
      await rejected(
        () =>
          updateSettingsAsync(
            sql,
            ADMIN,
            { llm: { promptTemplate: "Translate" } },
            OPTIONS,
            EXTRAS,
          ),
        "bad_request",
      );
      await rejected(
        () =>
          updateSettingsAsync(
            sql,
            ADMIN,
            { llm: { promptTemplate: "%% %strings%\nTranslate" } },
            OPTIONS,
            EXTRAS,
          ),
        "bad_request",
      );
      await rejected(
        () =>
          updateSettingsAsync(
            sql,
            ADMIN,
            { llm: { promptTemplate: "%strings% %unknown%" } },
            OPTIONS,
            EXTRAS,
          ),
        "bad_request",
      );
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { llm: { model: "../files" } }, OPTIONS, EXTRAS),
        "bad_request",
      );
      const result = await updateSettingsAsync(
        sql,
        ADMIN,
        { llm: { promptTemplate: "%% %note%\n%strings%", model: "model-v2" } },
        OPTIONS,
        EXTRAS,
      );
      checkEqual(
        [result.settings.llm.promptTemplate, result.settings.llm.model],
        ["%% %note%\n%strings%", "model-v2"],
      );
    },
  },
  {
    name: "source-language changes require an empty project and remove that target",
    async run(sql) {
      await empty(sql);
      await addProjectLanguageAsync(sql, ADMIN, "de", OPTIONS);
      const result = await updateSettingsAsync(
        sql,
        ADMIN,
        { sourceLanguage: "DE" },
        OPTIONS,
        EXTRAS,
      );
      checkEqual([result.settings.sourceLanguage, result.languages, result.files], ["de", [], []]);
    },
  },
  {
    name: "populated projects refuse source changes including inactive strings",
    async run(sql) {
      await seed(sql);
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { sourceLanguage: "fr" }, OPTIONS, EXTRAS),
        "bad_request",
      );
      await sql.commit(3, [{ sql: "UPDATE strings SET active = 0" }]);
      await rejected(
        () => updateSettingsAsync(sql, ADMIN, { sourceLanguage: "fr" }, OPTIONS, EXTRAS),
        "bad_request",
      );
      const [settings] = await sql.read([{ sql: "SELECT data FROM settings" }]);
      checkEqual(settings, []);
    },
  },
  {
    name: "competing patches remerge nested fields and preserve unrelated changes",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await updateSettingsAsync(
              sql,
              SYSTEM,
              { name: "Concurrent", llm: { batchSize: 7, context: { fileContext: false } } },
              OPTIONS,
              EXTRAS,
            );
          return rows;
        },
      };
      const result = await updateSettingsAsync(
        changing,
        ADMIN,
        { llm: { neighbours: 1, context: { otherLanguages: ["FR"] } } },
        OPTIONS,
        EXTRAS,
      );
      checkEqual(
        [
          reads,
          result.settings.name,
          result.settings.llm.batchSize,
          result.settings.llm.neighbours,
          result.settings.llm.context.fileContext,
          result.settings.llm.context.otherLanguages,
        ],
        [2, "Concurrent", 7, 1, false, ["fr"]],
      );
    },
  },
  {
    name: "administrator demotion prevents a stale settings commit",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(
        () => updateSettingsAsync(changing, ADMIN, { name: "Late" }, OPTIONS, EXTRAS),
        "forbidden",
      );
      const [settings] = await sql.read([{ sql: "SELECT data FROM settings" }]);
      checkEqual([reads, settings], [2, []]);
    },
  },
  {
    name: "concurrent first uploads prevent a previously allowed source change",
    async run(sql) {
      await empty(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await uploadAsync(
              sql,
              SYSTEM_AUTHOR,
              {
                files: [
                  { path: "common.json", repoPath: "common.json", content: '{"title":"Hello"}' },
                ],
              },
              { model: "test", clock: () => 100, llmAvailable: false },
            );
          return rows;
        },
      };
      await rejected(
        () => updateSettingsAsync(changing, ADMIN, { sourceLanguage: "de" }, OPTIONS, EXTRAS),
        "bad_request",
      );
      checkEqual(reads, 2);
    },
  },
  {
    name: "QA retries check the latest translation value",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          if (reads === 1)
            await sql.commit(3, [
              { sql: "UPDATE strings SET source = '\"Play %name%\"' WHERE id = 2" },
              {
                sql: "UPDATE translations SET value = '\"Spielen %name%\"' WHERE string_id = 2 AND language = 'de'",
              },
            ]);
          return rows;
        },
      };
      await updateSettingsAsync(
        changing,
        ADMIN,
        { syntax: { prefix: "%", suffix: "%" } },
        OPTIONS,
        EXTRAS,
      );
      checkEqual([reads, await qa(sql)], [2, { qa_errors: 0, qa_warnings: 0 }]);
    },
  },
  {
    name: "a failed batch rolls back stored settings and QA together",
    async run(sql) {
      await seed(sql);
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_settings_table VALUES (1)" },
          ]),
      };
      let failure: unknown;
      try {
        await updateSettingsAsync(
          failing,
          ADMIN,
          { name: "Failed", syntax: { prefix: "%", suffix: "%" } },
          OPTIONS,
          EXTRAS,
        );
      } catch (error) {
        failure = error;
      }
      check(failure instanceof Error);
      const [settings, revision] = await sql.read([
        { sql: "SELECT data FROM settings" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ]);
      checkEqual(
        [settings, revision[0].value, await qa(sql)],
        [[], "3", { qa_errors: 0, qa_warnings: 0 }],
      );
    },
  },
  {
    name: "validated entry points preserve permission errors and log changed keys once",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        defaultModel: "test",
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(() => api.updateSettings(ANONYMOUS, { name: "" }), "unauthorized");
      await rejected(
        () => api.updateSettings({ type: "token", tokenId: 7 }, { name: "Game" }),
        "forbidden",
      );
      await rejected(() => api.updateSettings(ADMIN, { name: "" }), "validation_failed");
      await rejected(
        () => api.updateSettings(ADMIN, { unknown: true } as never),
        "validation_failed",
      );
      const saved = await api.updateSettings(ADMIN, { name: "Game" });
      checkEqual([saved.settings.name, saved.models, saved.llmAvailable], ["Game", [], false]);
      await api.updateSettings(ADMIN, { name: "Game" });
      checkEqual(logs, [
        ["Settings changed", { changed: ["name"], actor: { type: "user", id: 1 } }],
      ]);
    },
  },
  {
    name: "settings commit before awaiting bounded model metadata",
    async run(sql) {
      await seed(sql);
      let calls = 0;
      let modelStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        modelStarted = resolve;
      });
      let finishModels!: (models: string[]) => void;
      const pending = new Promise<string[]>((resolve) => {
        finishModels = resolve;
      });
      const api = asyncWriteMethods({
        sql,
        defaultModel: "test",
        models: () => {
          calls++;
          modelStarted();
          return pending;
        },
      });
      const updating = api.updateSettings(ADMIN, { name: "Saved" });
      await started;
      const [settings] = await sql.read([{ sql: "SELECT data FROM settings WHERE id = 1" }]);
      checkEqual(JSON.parse(settings[0].data as string).name, "Saved");
      checkEqual((await updating).models, []);
      checkEqual((await api.updateSettings(ADMIN, { name: "Saved" })).models, []);
      checkEqual(calls, 2);
      finishModels([]);
    },
  },
];
