// SPDX-License-Identifier: MIT
import { openNodeSqlite, type NodeSqlite } from "./node_sqlite.ts";
import { SQL_MAX_PARAMS, type Sql, type Statement } from "../ports.ts";
import { RevisionConflict, REVISION_CONFLICT_MESSAGE, readStatement } from "../write.ts";

/** Opens the batch port; callers install the schema through migrate(). */
export function openAsyncSqlite(path: string) {
  const opened = openNodeSqlite(path);
  return { sql: createAsyncSqlite(opened), db: opened.db, close: opened.close };
}

/** Uses the host's existing connection so snapshots, checkpoints and writes share it. */
export function createAsyncSqlite(opened: NodeSqlite): Sql {
  const execute = (statement: Statement) => {
    const params = statement.params ?? [];
    if (params.length > SQL_MAX_PARAMS) throw new RangeError("Too many SQL parameters");
    return opened.sql.query(statement.sql, ...params);
  };
  const sql: Sql = {
    async read(statements) {
      opened.db.exec("BEGIN");
      opened.db.exec("PRAGMA query_only = ON");
      try {
        const rows = statements.map((statement) =>
          execute({ ...statement, sql: readStatement(statement.sql) }),
        );
        opened.db.exec("COMMIT");
        return rows;
      } catch (error) {
        if (opened.db.isTransaction) opened.db.exec("ROLLBACK");
        throw error;
      } finally {
        opened.db.exec("PRAGMA query_only = OFF");
      }
    },
    async commit(revision, statements) {
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new RangeError("Invalid project revision");
      }
      try {
        opened.sql.transaction(() => {
          execute({
            sql: "UPDATE revision_guard SET expected_revision = ? WHERE id = 1",
            params: [revision],
          });
          statements.forEach(execute);
        });
        return revision + 1;
      } catch (error) {
        if (error instanceof Error && error.message.includes(REVISION_CONFLICT_MESSAGE)) {
          throw new RevisionConflict();
        }
        throw error;
      }
    },
    async migrate(statements) {
      opened.sql.transaction(() => {
        statements.forEach(execute);
      });
    },
  };
  return sql;
}
