// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

export function makeTempDir(options: { dir?: string; prefix?: string } = {}): Promise<string> {
  return fs.mkdtemp(join(options.dir ?? tmpdir(), options.prefix ?? "quaso-"));
}

export async function makeTempFile(
  options: { dir?: string; prefix?: string; suffix?: string } = {},
): Promise<string> {
  const path = join(
    options.dir ?? tmpdir(),
    `${options.prefix ?? "quaso-"}${crypto.randomUUID()}${options.suffix ?? ""}`,
  );
  const file = await fs.open(path, "wx", 0o600);
  await file.close();
  return path;
}

export async function* walk(
  root: string,
  options: { includeDirs?: boolean; followSymlinks?: boolean; match?: RegExp[] } = {},
): AsyncGenerator<{ path: string; name: string; isFile: boolean; isDirectory: boolean }> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() && !options.followSymlinks) continue;
    const info = entry.isSymbolicLink() ? await fs.stat(path) : entry;
    const isDirectory = info.isDirectory();
    const matches = !options.match || options.match.some((pattern) => pattern.test(path));
    if (matches && (!isDirectory || options.includeDirs !== false)) {
      yield { path, name: basename(path), isFile: info.isFile(), isDirectory };
    }
    if (isDirectory) yield* walk(path, options);
  }
}
