// SPDX-License-Identifier: MIT
/**
 * `quaso.lock.json`: what `quaso translate` remembers between runs without an instance. For
 * each translation in the repository, it keeps the hash of the source text the translation
 * was made for. The next run then knows which translations to make again because their
 * source text changed, and that a value equal to the source text is a translation, not the
 * source text written in place of a missing one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalValue,
  entryKey,
  entryValue,
  hashValue,
  type SourceEntry,
  type TextValue,
} from "@quaso/core";
import type { Project } from "./config.ts";
import { usageError } from "./errors.ts";
import { utf8, writeAtomic } from "./fs.ts";

export const LOCK_FILE = "quaso.lock.json";

/** Enough of a SHA-256 to tell a changed source text, and short enough to commit. */
const HASH_LENGTH = 16;

/** Source hashes by language, then by the file's server path, then by `entryKey()`. */
type Translations = Record<string, Record<string, Record<string, string>>>;

export class Lock {
  readonly #path: string;
  #translations: Translations;

  private constructor(path: string, translations: Translations) {
    this.#path = path;
    this.#translations = translations;
  }

  /** The project's lock; an empty one when the project has none yet. */
  static async load(project: Project): Promise<Lock> {
    const path = join(project.dir, LOCK_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return new Lock(path, {});
      throw error;
    }
    try {
      const lock = JSON.parse(text);
      if (lock.version !== 1 || !isRecord(lock.translations)) throw new Error();
      return new Lock(path, lock.translations);
    } catch {
      throw usageError(`Can't read ${LOCK_FILE}: it isn't a lock file this version wrote.`, {
        hint: `Restore it from Git, or delete it: translations then count as made for the current source text.`,
      });
    }
  }

  /**
   * The values of a translation file that translate the current source text. A value the lock
   * doesn't know was written by someone else, so it counts, unless it equals the source text.
   */
  current(
    language: string,
    file: string,
    entries: readonly SourceEntry[],
    values: ReadonlyMap<string, TextValue>,
  ): Map<string, TextValue> {
    const known = this.#translations[language]?.[file] ?? {};
    const current = new Map<string, TextValue>();
    for (const entry of entries) {
      const key = entryKey(entry.kind, entry.keyPath);
      const value = values.get(key);
      const source = entryValue(entry);
      if (value === undefined || source === undefined) continue;
      const madeFor = known[key];
      const isCurrent =
        madeFor === undefined
          ? canonicalValue(value) !== canonicalValue(source)
          : madeFor === sourceHash(source);
      if (isCurrent) current.set(key, value);
    }
    return current;
  }

  /** Records that a language's file now translates `translated` (by `entryKey()`). */
  record(
    language: string,
    file: string,
    entries: readonly SourceEntry[],
    translated: ReadonlySet<string>,
  ): void {
    const hashes: Record<string, string> = {};
    for (const entry of entries) {
      const key = entryKey(entry.kind, entry.keyPath);
      const source = entryValue(entry);
      if (source !== undefined && translated.has(key)) hashes[key] = sourceHash(source);
    }
    this.#translations[language] = { ...this.#translations[language], [file]: hashes };
  }

  /** Writes the lock, without the languages and files the project no longer has. */
  async save(languages: readonly string[], files: readonly string[]): Promise<void> {
    const kept: Translations = {};
    for (const language of [...languages].sort()) {
      const byFile = this.#translations[language] ?? {};
      kept[language] = {};
      for (const file of [...files].sort()) {
        if (byFile[file] !== undefined) kept[language][file] = byFile[file];
      }
    }
    this.#translations = kept;
    const text = JSON.stringify({ version: 1, translations: kept }, null, 2);
    await writeAtomic(this.#path, utf8(`${text}\n`));
  }
}

function sourceHash(source: TextValue): string {
  return hashValue(source).slice(0, HASH_LENGTH);
}

function isRecord(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
