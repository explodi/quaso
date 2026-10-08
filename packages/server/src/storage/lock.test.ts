// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { assertRejects } from "@std/assert";
import { acquireLock, LockBusyError } from "./lock.ts";

test("a second lock on the same folder fails while the first is held", {}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const first = await acquireLock(dir);
    const error = await assertRejects(() => acquireLock(dir, 100), LockBusyError);
    if (!error.message.includes(dir)) throw new Error(error.message);
    first.release();
    const again = await acquireLock(dir, 1000);
    again.release();
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
