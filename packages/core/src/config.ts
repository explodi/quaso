// SPDX-License-Identifier: MIT
/**
 * `quaso.config.json`, the CLI's config file (design §5.10, CLI-2). The CLI validates it
 * with this schema, and the server publishes its JSON Schema at `/schema/config-v1.json`.
 */
import { type Infer, s, toJsonSchema } from "./schema.ts";
import { isValidLanguageTag } from "./text.ts";

/** The largest maximum length a string may have. */
export const MAX_LENGTH_LIMIT = 100_000;

/** A BCP 47 language tag, such as `de`, `pt-BR` or `zh-Hans`. */
export const LanguageTag = s
  .refine(s.string({ minLength: 1, maxLength: 64 }), (tag) =>
    isValidLanguageTag(tag) ? undefined : `"${tag}" is not a valid BCP 47 language tag`,
  )
  .describe("A BCP 47 language tag, such as de, pt-BR or zh-Hans");

export const FileMapping = s.object({
  source: s
    .string({ minLength: 1 })
    .describe(
      "Glob of the source-language files, relative to the config file, such as src/locales/en/**/*.json",
    ),
  translation: s
    .refine(s.string({ minLength: 1 }), (pattern) =>
      pattern.includes("{lang}") ? undefined : "must contain {lang}",
    )
    .describe(
      "Where translations go, with {lang} (the language as the app names it) and {path} (the source file's path below the folder where the glob starts), such as src/locales/{lang}/{path}",
    ),
  exclude: s
    .array(s.string({ minLength: 1 }))
    .optional()
    .describe("Globs of source files to leave out"),
});

export const LengthLimit = s.object({
  file: s
    .string({ minLength: 1 })
    .describe(
      "The file's path as the server knows it: below the folder where the glob starts, such as store.json",
    ),
  key: s
    .string({ minLength: 1 })
    .describe(
      'The key path, displayed with dots, such as title. When several strings share it, add #text, #plural or #ordinal, or give the key path as a JSON array, such as ["a.b"]',
    ),
  maxLength: s
    .integer({ min: 1, max: MAX_LENGTH_LIMIT })
    .describe("Maximum length, in user-perceived characters"),
});

export const PluralExclusion = s.object({
  file: s.string({ minLength: 1 }),
  key: s
    .string({ minLength: 1 })
    .describe(
      'The key path of a group of keys that only look like plurals, without the category: menu.power for menu.power_one and menu.power_other, or place_ordinal for place_ordinal_one and place_ordinal_other. A JSON array, such as ["a.b", "power"], matches the key path exactly.',
    ),
});

export const QuasoConfig = s.object({
  $schema: s.string().optional(),
  hostname: s
    .string({ minLength: 1 })
    .optional()
    .describe("The Quaso instance, such as translate.yourgame.com. QUASO_HOSTNAME wins over it."),
  sourceLanguage: LanguageTag.describe("The language of the source files"),
  languages: s
    .array(LanguageTag, { unique: true })
    .describe("The languages to download and translate. upload adds those the instance lacks."),
  translationsInRepository: s
    .array(LanguageTag, { unique: true })
    .optional()
    .describe(
      "Languages written in the repository: upload imports their selected translation files as blue",
    ),
  languageMapping: s
    .record(s.string({ minLength: 1 }))
    .optional()
    .describe(
      'Folder names for languages whose name in the app differs from their tag, such as { "zh-Hans": "zh-CN" }',
    ),
  files: s.array(FileMapping, { minItems: 1 }),
  limits: s
    .array(LengthLimit)
    .optional()
    .describe(
      "Maximum lengths, such as for app store fields (FMT-4). They win over limits set on the website.",
    ),
  pluralExclusions: s.array(PluralExclusion).optional(),
  outdated: s
    .enum(["write", "omit"])
    .optional()
    .describe(
      "Download older-source translations (default: write), or omit them so the app falls back to the source",
    ),
  untranslated: s
    .enum(["source", "omit"])
    .optional()
    .describe(
      "What download writes for untranslated strings: the source text (default) or nothing, for apps that fall back to the source language themselves",
    ),
});

export type QuasoConfig = Infer<typeof QuasoConfig>;
export type FileMapping = Infer<typeof FileMapping>;
export type LengthLimit = Infer<typeof LengthLimit>;
export type PluralExclusion = Infer<typeof PluralExclusion>;

/** The config file's JSON Schema, as the server publishes it. */
export function configJsonSchema(id?: string) {
  return toJsonSchema(QuasoConfig, { id, title: "quaso.config.json" });
}
