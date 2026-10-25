// SPDX-License-Identifier: MIT
/**
 * `quaso.config.json`, the CLI's config file (design §5.10, CLI-2). The CLI validates it
 * with this schema, and the server publishes its JSON Schema at `/schema/config-v1.json`.
 */
import { globProblem, globToRegExp } from "./glob.ts";
import { isArgumentName, isSelectKey } from "./icu.ts";
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

/** A folder below the project's root on the server, such as `text` or `text/menus`. */
export const FolderPath = s
  .refine(s.string({ minLength: 1, maxLength: 512 }), (path) => {
    if (path.startsWith("/") || path.includes("\\")) return "must be relative, with / separators";
    if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return "must not contain empty, . or .. segments, or end with /";
    }
    return undefined;
  })
  .describe("A folder on the server, such as text or text/menus");

export const FileMapping = s.object({
  source: s
    .string({ minLength: 1 })
    .describe(
      "Glob of the source-language files, relative to the config file, such as src/locales/en/**/*.json; .md and .markdown files are documents, translated whole",
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
  folder: FolderPath.optional().describe(
    "A folder the server keeps these files in, such as text: text/menus/main.json instead of menus/main.json. Translations still go to {path} without it",
  ),
});

export const LengthLimit = s.object({
  file: s
    .string({ minLength: 1 })
    .describe(
      "The file's path as the server knows it: below the folder where the glob starts, inside the mapping's folder, such as store.json",
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

const FileGlob = s.refine(
  s.string({ minLength: 1, maxLength: 512 }),
  (pattern) => globProblem(pattern) ?? undefined,
);
const KeyGlob = s.refine(
  s.string({ minLength: 1, maxLength: 512 }),
  (pattern) => globProblem(pattern, ".") ?? undefined,
);

/**
 * An argument the app passes to its ICU messages that the English may not show, such as the
 * gender of a post's author, so that a translation can agree with it (`checkTranslation`).
 */
export const ArgumentDeclaration = s.object({
  name: s
    .refine(s.string({ minLength: 1, maxLength: 100 }), (name) =>
      isArgumentName(name) ? undefined : "must be an ICU argument name: letters, digits, _ and $",
    )
    .describe("The argument's name in the messages, such as authorGender"),
  cases: s
    .array(
      s.refine(s.string({ minLength: 1, maxLength: 100 }), (key) => {
        if (key === "other") return "is always a case: leave it out";
        return isSelectKey(key) ? undefined : "must be a select case key: letters, digits, _ and -";
      }),
      { minItems: 1, maxItems: 20, unique: true },
    )
    .describe(
      "The values the app passes, as select case keys, such as female and male. other, which every select block needs, is always a case: leave it out",
    ),
  description: s
    .string({ minLength: 1, maxLength: 1000 })
    .describe(
      "For translators and the LLM: what the value is, and what other stands for, such as: The gender of the person who wrote the post. other: nonbinary, or not known.",
    ),
  files: s
    .array(FileGlob, { minItems: 1 })
    .optional()
    .describe(
      "Globs of the files whose strings receive it, by their path on the server (as limits name them), such as feed.json or posts/**. Default: every file",
    ),
  keys: s
    .array(KeyGlob, { minItems: 1 })
    .optional()
    .describe(
      "Globs of the keys that receive it, displayed with dots, such as posts.*: * stays within one key, ** spans several. Default: every key",
    ),
});

/** The declared arguments, each name once. */
export const ArgumentDeclarations = s
  .refine(s.array(ArgumentDeclaration, { maxItems: 50 }), (declarations) => {
    const names = declarations.map((declaration) => declaration.name);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    return repeated === undefined ? undefined : `declare ${repeated} once`;
  })
  .describe(
    "Arguments the app passes to its ICU messages that the English may not show, such as a person's gender, so that translations can agree with them. Only with ICU MessageFormat",
  );

export const QuasoConfig = s.object({
  $schema: s.string().optional(),
  hostname: s
    .string({ minLength: 1 })
    .optional()
    .describe("The Quaso instance, such as translate.yourgame.com. QUASO_HOSTNAME wins over it."),
  descriptionSuffix: s
    .string({ minLength: 1, maxLength: 100 })
    .optional()
    .describe("Keys ending with this suffix describe their source key and are not translated"),
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
  arguments: ArgumentDeclarations.optional(),
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
export type ArgumentDeclaration = Infer<typeof ArgumentDeclaration>;

/** A declared argument as a string receives it: what the checks, the LLM and translators see. */
export type StringArgument = Pick<ArgumentDeclaration, "name" | "cases" | "description">;

/**
 * Which declared arguments each string receives: those whose `files` globs match its file's
 * path on the server and whose `keys` globs match its key, displayed with dots.
 */
export function argumentResolver(
  declarations: readonly ArgumentDeclaration[],
): (file: string, key: string) => StringArgument[] {
  const scopes = declarations.map((declaration) => ({
    argument: {
      name: declaration.name,
      cases: declaration.cases,
      description: declaration.description,
    },
    files: declaration.files?.map((pattern) => globToRegExp(pattern)),
    keys: declaration.keys?.map((pattern) => globToRegExp(pattern, ".")),
  }));
  return (file, key) =>
    scopes
      .filter((scope) => {
        const inFile = scope.files === undefined || scope.files.some((glob) => glob.test(file));
        const inKeys = scope.keys === undefined || scope.keys.some((glob) => glob.test(key));
        return inFile && inKeys;
      })
      .map((scope) => scope.argument);
}

/** The config file's JSON Schema, as the server publishes it. */
export function configJsonSchema(id?: string) {
  return toJsonSchema(QuasoConfig, { id, title: "quaso.config.json" });
}
