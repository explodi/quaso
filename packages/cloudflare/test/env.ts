// SPDX-License-Identifier: MIT
/** The test Worker's bindings: the real ones, a fake container, and a bare object. */
import { env as testEnv } from "cloudflare:test";
import type { FakeContainer, TestObject } from "./worker.ts";
import { createD1Sql } from "../../service/src/adapters/d1_sql.ts";
import { handleD1 } from "../src/d1_handler.ts";

export interface TestEnv extends Omit<Env, "QUASO_CONTAINER"> {
  QUASO_CONTAINER: DurableObjectNamespace<FakeContainer>;
  TEST_D1: D1Database;
  TEST_OBJECT: DurableObjectNamespace<TestObject>;
}

export const env = testEnv as unknown as TestEnv;

/** A new, empty Durable Object for one test. */
export function freshObject(): DurableObjectStub<TestObject> {
  return env.TEST_OBJECT.get(env.TEST_OBJECT.newUniqueId());
}

export const sql = createD1Sql({
  fetch: (input, init) => handleD1(new Request(input, init), env.TEST_D1),
});
