// SPDX-License-Identifier: MIT
import { MIGRATION_1, INITIAL_STATEMENTS } from "./migrations/001_initial.ts";
import type { Statement } from "./ports.ts";

/** Schema history begins at Beta 2; future releases append migrations. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Every migration, in version order: one file each in `migrations/`. */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_1];

/** The database schema version after every migration. */
export const DATABASE_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

export interface BatchMigration {
  version: number;
  name: string;
  statements: Statement[];
}

export const BATCH_MIGRATIONS: readonly BatchMigration[] = [
  {
    version: MIGRATION_1.version,
    name: MIGRATION_1.name,
    statements: INITIAL_STATEMENTS,
  },
];
