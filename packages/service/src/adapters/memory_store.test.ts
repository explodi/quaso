// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { createMemoryStore } from "./memory_store.ts";
import { STORE_CASES } from "../testing/store_cases.ts";

for (const testCase of STORE_CASES)
  test(`memory store: ${testCase.name}`, () => testCase.run(createMemoryStore()));
