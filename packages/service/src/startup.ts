// SPDX-License-Identifier: MIT
/** Database initialization shared by hosts of the async service. */
import { FALLBACK_MODEL } from "./context.ts";
import { migrateAsync, type MigrateOptions, type MigrateResult } from "./migrate.ts";
import type { Sql } from "./ports.ts";
import { defaultSettings } from "./settings.ts";

export async function initializeDatabase(
  sql: Sql,
  options: {
    defaultModel?: string;
    beforeMigrate?: MigrateOptions["beforeMigrate"];
  } = {},
): Promise<MigrateResult> {
  const migrated = await migrateAsync(sql, { beforeMigrate: options.beforeMigrate });
  // Defaults must not alter an unfinished restore; existing project settings also win.
  await sql.migrate([
    {
      sql: `INSERT INTO settings (id, data) SELECT 1, ?
        WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'restore')
        ON CONFLICT (id) DO NOTHING`,
      params: [JSON.stringify(defaultSettings(options.defaultModel ?? FALLBACK_MODEL))],
    },
  ]);
  return migrated;
}
