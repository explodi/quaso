// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * Lists the repository's files: tracked, plus untracked ones that git doesn't ignore.
 * Shared by the check scripts.
 */
export async function repositoryFiles(): Promise<string[]> {
  const output = await new Deno.Command("git", {
    args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    stdout: "piped",
  }).output();
  if (!output.success) throw new Error("git ls-files failed");
  const files = new TextDecoder().decode(output.stdout).split("\0").filter(Boolean);
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
