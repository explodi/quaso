// SPDX-License-Identifier: MIT
/**
 * The project's languages (design §5.3): the target languages, never the source language,
 * with their plural overrides. The service is the last word on plural categories (design
 * §5.1), so it reports the categories it uses for each language.
 */
import {
  canonicalLanguageTag,
  languageName,
  pluralCategories,
  type PluralCategory,
  type PluralOverride,
  textDirection,
} from "@quaso/core";
import type { Context } from "./context.ts";
import { fromJsonOrNull } from "./db.ts";
import { badRequest, ServiceError } from "./errors.ts";
import type { SyncSql } from "./ports.ts";

export interface Language {
  tag: string;
  instructions: string;
  pluralOverride: PluralOverride | undefined;
  createdAt: number;
}

export type LanguageRow = {
  tag: string;
  instructions: string;
  plural_override: string | null;
  created_at: number;
};

/** Every project language, sorted by tag. */
export function loadLanguages(sql: SyncSql): Language[] {
  return sql
    .query<LanguageRow>(
      "SELECT tag, instructions, plural_override, created_at FROM languages ORDER BY tag",
    )
    .map(toLanguage);
}

/** The project language with this tag (in any case, such as `pt-br`), or `undefined`. */
export function findLanguage(sql: SyncSql, tag: string): Language | undefined {
  const canonical = canonicalLanguageTag(tag);
  if (canonical === null) return undefined;
  const rows = sql.query<LanguageRow>(
    "SELECT tag, instructions, plural_override, created_at FROM languages WHERE tag = ?",
    canonical,
  );
  return rows.length === 0 ? undefined : toLanguage(rows[0]);
}

/**
 * The project language with this tag. An unknown one fails with `not_found`, or with
 * `bad_request` where the language comes from a request body.
 */
export function requireLanguage(
  ctx: Context,
  tag: string,
  code: "not_found" | "bad_request" = "not_found",
): Language {
  const language = findLanguage(ctx.sql, tag);
  if (language !== undefined) return language;
  const message = `The project has no language ${tag}.`;
  throw code === "not_found"
    ? new ServiceError("not_found", message)
    : badRequest(message, [{ language: tag, message }]);
}

/** Adds a language. Returns false if the project already has it. */
export function addLanguage(ctx: Context, tag: string): boolean {
  const rows = ctx.sql.query(
    "INSERT INTO languages (tag, created_at) VALUES (?, ?) ON CONFLICT (tag) DO NOTHING RETURNING tag",
    tag,
    ctx.clock(),
  );
  return rows.length > 0;
}

/** The plural categories the service uses for a language, after its override. */
export function pluralFor(
  tag: string,
  override: PluralOverride | undefined,
): { cardinal: PluralCategory[]; ordinal: PluralCategory[] } {
  return {
    cardinal: pluralCategories(tag, { override }),
    ordinal: pluralCategories(tag, { ordinal: true, override }),
  };
}

/** A language as `LanguageProgress` describes it, without the counts. */
export interface LanguageFacts {
  tag: string;
  name: string;
  direction: "ltr" | "rtl";
  plural: { cardinal: PluralCategory[]; ordinal: PluralCategory[] };
}

/** A language's name, direction and plural categories. */
export function languageFacts(language: Language): LanguageFacts {
  return {
    tag: language.tag,
    name: languageName(language.tag),
    direction: textDirection(language.tag),
    plural: pluralFor(language.tag, language.pluralOverride),
  };
}

export function toLanguage(row: LanguageRow): Language {
  return {
    tag: row.tag,
    instructions: row.instructions,
    pluralOverride: fromJsonOrNull<PluralOverride>(row.plural_override) ?? undefined,
    createdAt: row.created_at,
  };
}
