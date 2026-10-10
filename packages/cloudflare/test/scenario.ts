// SPDX-License-Identifier: MIT
/** One fixed scenario compares the same async service on local SQLite and deployed D1. */
import type { ImportRequest, UploadRequest } from "../../core/mod.ts";
import {
  ANONYMOUS,
  backupJsonStream,
  createAsyncService,
  type Sql,
  SYSTEM,
} from "../../service/mod.ts";

/** The fixed time of the scenario: 2026-09-24, noon UTC. */
export const SCENARIO_TIME = Date.UTC(2026, 8, 24, 12);

export interface ScenarioInput {
  upload: UploadRequest;
  imports: ImportRequest[];
}

/** The scenario's results, as JSON would carry them. */
export type ScenarioOutput = Record<string, unknown>;

/** Runs the scenario on an empty database. */
export async function runScenario(sql: Sql, input: ScenarioInput): Promise<ScenarioOutput> {
  const service = createAsyncService({
    sql,
    scheduler: { schedule() {}, cancel() {} },
    secretKey: "scenario-secret-key-".repeat(4),
    clock: () => SCENARIO_TIME,
  });
  const start = await service.start();
  const upload = await service.upload(SYSTEM, input.upload);
  const uploadAgain = await service.upload(SYSTEM, {
    ...input.upload,
    dryRun: true,
  });
  const imports = [];
  for (const request of input.imports) {
    imports.push(await service.importTranslations(SYSTEM, request));
  }
  // Exercise every community table in the portable backup, including composite vote keys.
  await sql.migrate([
    {
      sql: "INSERT INTO users (email, display_name, role, created_at) VALUES ('volunteer@example.test', 'Volunteer', 'contributor', ?)",
      params: [SCENARIO_TIME],
    },
  ]);
  const [people] = await sql.read([
    { sql: "SELECT id FROM users WHERE email = 'volunteer@example.test'" },
  ]);
  const person = people[0];
  const actor = { type: "user" as const, userId: Number(person.id) };
  const first = (await service.listStrings(ANONYMOUS, { language: "de", limit: 1 })).strings[0];
  await service.createGlossaryTerm(SYSTEM, { term: "Wayfarer", kind: "keep" });
  await service.addComment(actor, {
    stringId: first.id,
    body: "Please clarify the context",
    sourceIssue: true,
  });
  await service.updateSettings(SYSTEM, { languageRequestsEnabled: true });
  await service.requestLanguage(actor, {
    tag: "eo",
    message: "Esperanto please",
  });
  const backup = await new Response(backupJsonStream(service, SYSTEM)).json();
  const status = await service.getStatus(SYSTEM, {});
  return toJson({
    start,
    upload,
    uploadAgain,
    imports,
    project: await service.getProject(ANONYMOUS, {}),
    status,
    statusAgain: await service.getStatus(SYSTEM, {}),
    files: await service.listFiles(ANONYMOUS, { language: "pl" }),
    strings: await service.listStrings(ANONYMOUS, {
      language: "pl",
      limit: 500,
    }),
    outdated: await service.listStrings(ANONYMOUS, {
      language: "de",
      state: "untranslated",
    }),
    search: await service.listStrings(ANONYMOUS, { language: "fr", q: "play" }),
    activity: await service.getActivity(ANONYMOUS, {}),
    health: await service.getHealth(SYSTEM, {}),
    export: await service.exportFiles(SYSTEM, {}),
    backup,
    tables: await dumpTables(sql),
  });
}

/** Every table's rows, in order, by table name. */
export async function dumpTables(sql: Sql): Promise<Record<string, unknown[]>> {
  const [tables] = await sql.read([
    {
      sql: `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
     ORDER BY name`,
    },
  ]);
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const [rows] = await sql.read([{ sql: `SELECT * FROM "${name}" ORDER BY rowid` }]);
    out[String(name)] = rows;
  }
  return out;
}

/** A value as JSON carries it: no `undefined`, and bytes as arrays. */
function toJson(value: unknown): ScenarioOutput {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? Array.from(item) : item)),
  );
}
