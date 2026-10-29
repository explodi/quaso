// SPDX-License-Identifier: MIT
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { assert, test } from "vitest";
import { acquireLock, LockBusyError } from "./lock.ts";

test("a second lock on the same folder fails while the first is held", {}, async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "quaso-test-"));
  try {
    const first = await acquireLock(dir);
    const error = await acquireLock(dir, 100).catch((error: unknown) => error);
    assert(error instanceof LockBusyError);
    if (!error.message.includes(dir)) throw new Error(error.message);
    first.release();
    const again = await acquireLock(dir, 1000);
    again.release();
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
