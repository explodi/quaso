// SPDX-License-Identifier: MIT
/** The real service on an in-memory database, for the server's integration tests. */
import { createService, type Service, type ServiceOptions, silentLogger } from "@quaso/service";
import { openNodeSqlite } from "@quaso/service/node-sqlite";

/**
 * A started service on a new in-memory database; `close()` closes the database. `options`
 * adds to or replaces the defaults (such as `dev`, or a clock).
 */
export async function realService(
  options: Partial<ServiceOptions> = {},
): Promise<{ service: Service; close(): void }> {
  const database = openNodeSqlite(":memory:");
  try {
    const service = createService({
      sql: database.sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "test-secret-key-".repeat(4),
      logger: silentLogger,
      // Few iterations: the tests hash many passwords.
      passwordIterations: 1000,
      ...options,
    });
    await service.start();
    return { service, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
