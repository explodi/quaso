// SPDX-License-Identifier: MIT
/**
 * Line endings for `bun run cf:fixtures` (`fixtures.ts`). Git for Windows checks text files
 * out with CRLF by default, both the demo project's files and the fixture itself, so the
 * fixture is written from LF text, and compared whatever the endings on disk.
 */

/** The text with LF line endings. */
export function lf(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/** Whether the fixture on disk (`current`) holds `expected`, whatever its line endings. */
export function fixtureUpToDate(current: string, expected: string): boolean {
  return lf(current) === lf(expected);
}

/** Files with LF line endings, as they are in the repository. */
export function withLf<T extends { content: string }>(files: readonly T[]): T[] {
  return files.map((file) => ({ ...file, content: lf(file.content) }));
}
