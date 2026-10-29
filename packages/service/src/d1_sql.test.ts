// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { createD1Sql } from "./adapters/d1_sql.ts";
import { RevisionConflict } from "./write.ts";
import { ServiceError } from "./errors.ts";

test("D1: transport failures return unavailable without retrying writes", async () => {
  let calls = 0;
  const sql = createD1Sql({
    fetch: async () => {
      calls++;
      throw new TypeError("offline");
    },
  });
  const error = await sql.commit(0, []).catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.status).toBe(503);
  expect(calls).toBe(1);
});

test("D1: a revision conflict is distinct from an unavailable database", async () => {
  const sql = createD1Sql({ fetch: async () => new Response(null, { status: 409 }) });
  await expect(sql.commit(0, [])).rejects.toThrow(RevisionConflict);
  const offline = createD1Sql({ fetch: async () => new Response(null, { status: 503 }) });
  await expect(offline.read([{ sql: "SELECT 1" }])).rejects.toThrow(
    expect.objectContaining({ constructor: ServiceError, status: 503 }),
  );
});

test("D1: rejects missing batch results", async () => {
  const sql = createD1Sql({ fetch: async () => Response.json([]) });
  await expect(sql.read([{ sql: "SELECT 1" }])).rejects.toThrow(ServiceError);
});

test("D1: empty reads and migrations need no request", async () => {
  let calls = 0;
  const sql = createD1Sql({
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  expect(await sql.read([])).toStrictEqual([]);
  await sql.migrate([]);
  expect(calls).toBe(0);
});

test("D1: refuses bigints that cannot survive JSON as exact numbers", async () => {
  const sql = createD1Sql();
  await expect(sql.read([{ sql: "SELECT ?", params: [2n ** 60n] }])).rejects.toThrow(RangeError);
});
