// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@std/assert";
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
  const error = await assertRejects(() => sql.commit(0, []), ServiceError);
  assertEquals(error.status, 503);
  assertEquals(calls, 1);
});

test("D1: a revision conflict is distinct from an unavailable database", async () => {
  const sql = createD1Sql({ fetch: async () => new Response(null, { status: 409 }) });
  await assertRejects(() => sql.commit(0, []), RevisionConflict);
  const offline = createD1Sql({ fetch: async () => new Response(null, { status: 503 }) });
  assertEquals(
    (await assertRejects(() => offline.read([{ sql: "SELECT 1" }]), ServiceError)).status,
    503,
  );
});

test("D1: rejects missing batch results", async () => {
  const sql = createD1Sql({ fetch: async () => Response.json([]) });
  await assertRejects(() => sql.read([{ sql: "SELECT 1" }]), ServiceError);
});

test("D1: empty reads and migrations need no request", async () => {
  let calls = 0;
  const sql = createD1Sql({
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  assertEquals(await sql.read([]), []);
  await sql.migrate([]);
  assertEquals(calls, 0);
});

test("D1: refuses bigints that cannot survive JSON as exact numbers", async () => {
  const sql = createD1Sql();
  await assertRejects(() => sql.read([{ sql: "SELECT ?", params: [2n ** 60n] }]), RangeError);
});
