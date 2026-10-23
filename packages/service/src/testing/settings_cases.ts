// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { updateFolderAsync } from "../folders.ts";
import { getSettingsAsync } from "../settings_api.ts";
import { DEFAULT_PROMPT_TEMPLATE, defaultSettings } from "../settings.ts";
import { check, checkEqual } from "./assert.ts";
import { seedStringReads } from "./strings_cases.ts";

const ADMIN: Actor = { type: "user", userId: 1 };
const MANAGER: Actor = { type: "user", userId: 2 };
const CONTRIBUTOR: Actor = { type: "user", userId: 3 };
const EXTRAS = { models: ["model-a", "model-b"], llmAvailable: true };

async function seed(sql: Sql): Promise<void> {
  await seedStringReads(sql);
  await sql.commit(2, [
    { sql: "UPDATE users SET role = 'administrator' WHERE id = 1" },
    { sql: "UPDATE users SET role = 'manager' WHERE id = 2" },
    {
      sql: "INSERT INTO settings (id, data) VALUES (1, ?)",
      params: [
        JSON.stringify({ name: "Wayfarer", description: "A game", llm: { model: "stored-model" } }),
      ],
    },
    {
      sql: "UPDATE languages SET instructions = 'Use informal speech', plural_override = ? WHERE tag = 'de'",
      params: [JSON.stringify({ cardinal: ["other"] })],
    },
    {
      sql: "UPDATE files SET context = 'Menu', generated_context = 'Generated menu' WHERE path = 'common.json'",
    },
    { sql: "UPDATE files SET active = 0 WHERE path = 'Menus/main.json'" },
  ]);
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

export const SETTINGS_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "empty settings use the runtime defaults and supplied provider metadata",
    async run(sql) {
      const result = await getSettingsAsync(sql, SYSTEM, "runtime-model", EXTRAS);
      checkEqual(result, {
        settings: defaultSettings("runtime-model"),
        defaultPromptTemplate: DEFAULT_PROMPT_TEMPLATE,
        languages: [],
        files: [],
        folders: [],
        models: ["model-a", "model-b"],
        llmAvailable: true,
      });
    },
  },
  {
    name: "settings decode upgrade defaults, language overrides and active file contexts",
    async run(sql) {
      await seed(sql);
      const result = await getSettingsAsync(sql, ADMIN, "runtime-model", EXTRAS);
      checkEqual(
        [result.settings.name, result.settings.description, result.settings.llm.model],
        ["Wayfarer", "A game", "stored-model"],
      );
      checkEqual(result.settings.llm.context, defaultSettings("runtime-model").llm.context);
      checkEqual(
        result.languages.map((language) => language.tag),
        ["de", "fr"],
      );
      checkEqual(result.languages[0], {
        tag: "de",
        name: "German",
        direction: "ltr",
        instructions: "Use informal speech",
        pluralOverride: { cardinal: ["other"] },
        categories: { cardinal: ["other"], ordinal: ["other"] },
      });
      checkEqual(
        result.files.map((file) => [file.path, file.context, file.generatedContext]),
        [["common.json", "Menu", "Generated menu"]],
      );
      checkEqual([result.models, result.llmAvailable], [["model-a", "model-b"], true]);
    },
  },
  {
    name: "only administrators and system callers can read settings",
    async run(sql) {
      await seed(sql);
      await rejected(() => getSettingsAsync(sql, ANONYMOUS, "test", EXTRAS), "unauthorized");
      await rejected(
        () => getSettingsAsync(sql, { type: "user", userId: 2 }, "test", EXTRAS),
        "forbidden",
      );
      await rejected(
        () => getSettingsAsync(sql, { type: "user", userId: 999 }, "test", EXTRAS),
        "forbidden",
      );
      await rejected(
        () => getSettingsAsync(sql, { type: "token", tokenId: 7 }, "test", EXTRAS),
        "forbidden",
      );
      checkEqual((await getSettingsAsync(sql, SYSTEM, "test", EXTRAS)).settings.name, "Wayfarer");
    },
  },
  {
    name: "permissions and settings remain consistent across a concurrent demotion and edit",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          reads++;
          const rows = await sql.read(statements);
          await sql.commit(3, [
            { sql: "UPDATE users SET role = 'none' WHERE id = 1" },
            { sql: "UPDATE settings SET data = ?", params: [JSON.stringify({ name: "Changed" })] },
            { sql: "UPDATE languages SET instructions = 'Changed'" },
            { sql: "UPDATE files SET context = 'Changed'" },
          ]);
          return rows;
        },
      };
      const result = await getSettingsAsync(changing, ADMIN, "test", EXTRAS);
      checkEqual(
        [reads, result.settings.name, result.languages[0].instructions, result.files[0].context],
        [1, "Wayfarer", "Use informal speech", "Menu"],
      );
      await rejected(() => getSettingsAsync(sql, ADMIN, "test", EXTRAS), "forbidden");
      checkEqual((await getSettingsAsync(sql, SYSTEM, "test", EXTRAS)).settings.name, "Changed");
    },
  },
  {
    name: "invalid stored settings fail decoding after access has been checked",
    async run(sql) {
      await seed(sql);
      await sql.commit(3, [
        { sql: "UPDATE settings SET data = ?", params: [JSON.stringify({ name: 123 })] },
      ]);
      await rejected(() => getSettingsAsync(sql, SYSTEM, "test", EXTRAS), "internal");
      await rejected(() => getSettingsAsync(sql, ANONYMOUS, "test", EXTRAS), "unauthorized");
    },
  },
  {
    name: "settings list every folder of an active file, outermost first, with its context",
    async run(sql) {
      await seedFolders(sql);
      const result = await getSettingsAsync(sql, ADMIN, "test", EXTRAS);
      checkEqual(result.folders, [
        { path: "text", context: "Game text" },
        { path: "text/menus", context: "" },
      ]);
    },
  },
  {
    name: "a manager writes a folder's context, and a blank context removes it",
    async run(sql) {
      await seedFolders(sql);
      const written = await updateFolderAsync(
        sql,
        MANAGER,
        { path: "text/menus", context: "Menus" },
        200,
      );
      checkEqual(written, { path: "text/menus", context: "Menus" });
      const removed = await updateFolderAsync(sql, MANAGER, { path: "text", context: " " }, 300);
      checkEqual(removed, { path: "text", context: "" });
      const result = await getSettingsAsync(sql, ADMIN, "test", EXTRAS);
      checkEqual(result.folders, [
        { path: "text", context: "" },
        { path: "text/menus", context: "Menus" },
      ]);
    },
  },
  {
    name: "a folder without an active file is not found, and contributors can't write one",
    async run(sql) {
      await seedFolders(sql);
      const write = (actor: Actor, path: string) => () =>
        updateFolderAsync(sql, actor, { path, context: "x" }, 200);
      await rejected(write(MANAGER, "old"), "not_found");
      await rejected(write(MANAGER, "te_t"), "not_found");
      await rejected(write(MANAGER, "text/menus/main.json"), "not_found");
      await rejected(write(CONTRIBUTOR, "text"), "forbidden");
      await rejected(write(ANONYMOUS, "text"), "unauthorized");
    },
  },
];

/** Active files in text/ and text/menus/, a hidden one in old/, and contexts on text and old. */
async function seedFolders(sql: Sql): Promise<void> {
  await seed(sql);
  await sql.commit(3, [
    {
      sql: `INSERT INTO files (path, repo_path, format, active, created_at, updated_at) VALUES
        ('text/title.json', 'text/title.json', '{}', 1, 100, 100),
        ('text/menus/main.json', 'text/menus/main.json', '{}', 1, 100, 100),
        ('old/gone.json', 'old/gone.json', '{}', 0, 100, 100)`,
    },
    {
      sql: `INSERT INTO folders (path, context, updated_at) VALUES
        ('text', 'Game text', 100), ('old', 'Removed', 100)`,
    },
    {
      sql: "INSERT INTO users (id, display_name, role, created_at) VALUES (3, 'Helper', 'contributor', 100)",
    },
  ]);
}
