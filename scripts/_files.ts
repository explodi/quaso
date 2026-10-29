// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
/**
 * Lists the repository's files: tracked, plus untracked ones that git doesn't ignore.
 * Shared by the check scripts.
 */
export async function repositoryFiles(): Promise<string[]> {
  const output = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (output.status !== 0) throw new Error("git ls-files failed");
  const files = output.stdout.split("\0").filter(Boolean);
  const existing: string[] = [];
  for (const file of files) {
    try {
      if ((await fs.stat(file)).isFile()) existing.push(file);
    } catch {
      // Deleted in the working tree but still in the index.
    }
  }
  return existing;
}
