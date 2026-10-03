// SPDX-License-Identifier: MIT
/** The test Worker's bindings: the real ones, a fake container, and a bare object. */
import { env as testEnv } from "cloudflare:test";
import type { FakeContainer, TestObject } from "./worker.ts";
import type { LegacyDataEnv } from "../src/data_object.ts";

export interface TestEnv extends Omit<LegacyDataEnv, "QUASO_CONTAINER"> {
  QUASO_CONTAINER: DurableObjectNamespace<FakeContainer>;
  TEST_OBJECT: DurableObjectNamespace<TestObject>;
}

export const env = testEnv as unknown as TestEnv;

/** A new, empty Durable Object for one test. */
export function freshObject(): DurableObjectStub<TestObject> {
  return env.TEST_OBJECT.get(env.TEST_OBJECT.newUniqueId());
}
