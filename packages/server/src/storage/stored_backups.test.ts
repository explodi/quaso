// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORED_BACKUP_CASES } from "../../../service/src/testing/stored_backup_cases.ts";
import { createFolderStore } from "./folder_store.ts";
for (const testCase of STORED_BACKUP_CASES) {
  test(`stored backups on folders: ${testCase.name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "quaso-backups-"));
    try {
      await testCase.run(createFolderStore(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
