// SPDX-License-Identifier: MIT
/**
 * The project's settings: what an instance stores, what `PATCH /settings` changes, and the part
 * of them a repository can keep in `quaso.config.json` (`RepositorySettings`).
 */
import { PLURAL_CATEGORIES } from "./types.ts";
import { type Infer, s } from "./schema.ts";
import { isValidLanguageTag } from "./text.ts";

/** A BCP 47 language tag, such as `de`, `pt-BR` or `zh-Hans`. */
export const LanguageTag = s
  .refine(s.string({ minLength: 1, maxLength: 64 }), (tag) =>
    isValidLanguageTag(tag) ? undefined : `"${tag}" is not a valid BCP 47 language tag`,
  )
  .describe("A BCP 47 language tag, such as de, pt-BR or zh-Hans");

export const MeaningCheckSettings = s.object({
  enabled: s.boolean(),
  colours: s.enum(["blue", "all"]),
  onSave: s.boolean(),
  onApproval: s.boolean(),
  model: s.string({ maxLength: 200 }),
  countsAgainstBudget: s.boolean(),
});
export type MeaningCheckSettings = Infer<typeof MeaningCheckSettings>;

export const LlmSettings = s.object({
  meaningCheck: MeaningCheckSettings.optional(),
  translationMemory: s
    .boolean()
    .optional()
    .describe("Copy current translations of identical sources as green before asking the model"),
  autoTranslate: s.boolean().describe("Translate new and changed strings on upload (LLM-3)"),
  updateOutdated: s
    .boolean()
    .describe("On upload, update outdated translations too, proofread ones included"),
  model: s.string({ minLength: 1, maxLength: 200 }),
  suggestionModel: s
    .string({ maxLength: 200 })
    .describe("The model for the editor's LLM suggestions; blank uses the model above"),
  concurrency: s.integer({ min: 1, max: 64 }),
  monthlyTokenBudget: s.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).nullable(),
  promptTemplate: s.string({ minLength: 1, maxLength: 50_000 }),
  projectInstructions: s.string({ maxLength: 20_000 }),
  context: s.object({
    otherLanguages: s
      .array(LanguageTag)
      .describe("Languages whose translations of the same strings go into the prompt"),
    identicalStrings: s
      .boolean()
      .describe(
        "Current proofread and green translations of identical source strings elsewhere in the project",
      ),
    fileContext: s.boolean().describe("The file's context, written or generated"),
    glossary: s.boolean(),
  }),
  batchSize: s.integer({ min: 1, max: 100 }),
  neighbours: s.integer({ min: 0, max: 20 }),
  retries: s.integer({ min: 0, max: 5 }),
  safety: s.enum(["permissive", "default", "strict"]),
});
export type LlmSettings = Infer<typeof LlmSettings>;

export const EmailSettings = s.object({
  provider: s.enum(["none", "resend", "postmark", "cloudflare"]),
  from: s.refine(s.string({ maxLength: 320 }), (value) =>
    value === "" ||
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$|^[^<>\r\n]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(value)
      ? undefined
      : "must be a sender address, such as Quaso <quaso@example.com>",
  ),
  accountId: s.refine(s.string({ maxLength: 32 }), (value) =>
    value === "" || /^[a-f0-9]{32}$/i.test(value)
      ? undefined
      : "must be a 32-character Cloudflare account ID",
  ),
});
export type EmailSettings = Infer<typeof EmailSettings>;

export const ProjectSettings = s.object({
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.string({ maxLength: 20_000 }),
  sourceLanguage: LanguageTag,
  syntax: s.object({
    prefix: s.string({ minLength: 1, maxLength: 10 }),
    suffix: s.string({ minLength: 1, maxLength: 10 }),
    extra: s
      .array(
        s.object({
          prefix: s.string({ minLength: 1, maxLength: 10 }),
          suffix: s.string({ minLength: 1, maxLength: 10 }),
        }),
        { maxItems: 10 },
      )
      .optional()
      .describe("Delimiters of placeholders the app fills in itself, such as { and } for {name}"),
    optional: s
      .array(
        s.object({
          placeholder: s.string({ minLength: 1, maxLength: 100 }),
          languages: s.array(LanguageTag, { minItems: 1, maxItems: 200 }),
        }),
        { maxItems: 50 },
      )
      .optional()
      .describe("Placeholders some languages may leave out, such as {article}"),
    icu: s
      .boolean()
      .optional()
      .describe(
        "ICU MessageFormat ({name}, {n, plural, …}) instead of i18next's {{name}} and $t()",
      ),
  }),
  logoUrl: s.string({ maxLength: 2000 }).nullable(),
  links: s.array(
    s.object({
      label: s.string({ minLength: 1, maxLength: 80 }),
      url: s.string({ maxLength: 2000 }),
    }),
    { maxItems: 20 },
  ),
  llm: LlmSettings,
  languageRequestsEnabled: s.boolean(),
  fileHistoryDays: s.integer({ min: 0, max: 36500 }),
  backupRetentionDays: s.integer({ min: 1, max: 36500 }),
  email: EmailSettings,
});
export type ProjectSettings = Infer<typeof ProjectSettings>;

/** `PATCH /settings`: any top-level field; `llm` and `llm.context` merge. */
export const UpdateSettingsRequest = s.object({
  name: ProjectSettings.shape.name.optional(),
  description: ProjectSettings.shape.description.optional(),
  sourceLanguage: LanguageTag.optional(),
  syntax: ProjectSettings.shape.syntax.optional(),
  logoUrl: ProjectSettings.shape.logoUrl.optional(),
  links: ProjectSettings.shape.links.optional(),
  languageRequestsEnabled: ProjectSettings.shape.languageRequestsEnabled.optional(),
  fileHistoryDays: ProjectSettings.shape.fileHistoryDays.optional(),
  backupRetentionDays: ProjectSettings.shape.backupRetentionDays.optional(),
  email: EmailSettings.optional(),
  llm: s
    .object({
      ...LlmSettings.shape,
      context: LlmSettings.shape.context.partial(),
    })
    .partial()
    .optional(),
});
export type UpdateSettingsRequest = Infer<typeof UpdateSettingsRequest>;

export const PluralOverrideSchema = s.object({
  cardinal: s.array(s.enum(PLURAL_CATEGORIES), { unique: true }).optional(),
  ordinal: s.array(s.enum(PLURAL_CATEGORIES), { unique: true }).optional(),
});

/** `PATCH /languages/{tag}` */
export const UpdateLanguageRequest = s.object({
  instructions: s.string({ maxLength: 20_000 }).optional(),
  pluralOverride: PluralOverrideSchema.nullable().optional(),
});
export type UpdateLanguageRequest = Infer<typeof UpdateLanguageRequest>;

/**
 * The settings a repository keeps in `quaso.config.json`. Each one given replaces the
 * instance's on `quaso upload`, and `quaso translate` reads them when it runs without an
 * instance. Those left out stay as they are. Settings of the server itself (email, backups,
 * file history) are not among them.
 */
export const RepositorySettings = s
  .object({
    name: ProjectSettings.shape.name.optional().describe("The project's name, for the LLM"),
    description: ProjectSettings.shape.description
      .optional()
      .describe("What the game or app is, for the LLM"),
    syntax: ProjectSettings.shape.syntax.optional(),
    logoUrl: ProjectSettings.shape.logoUrl.optional(),
    links: ProjectSettings.shape.links.optional(),
    languageRequestsEnabled: ProjectSettings.shape.languageRequestsEnabled.optional(),
    llm: UpdateSettingsRequest.shape.llm,
    languages: s
      .record(UpdateLanguageRequest)
      .optional()
      .describe(
        'Instructions and plural overrides by language, such as { "de": { "instructions": "Use du." } }',
      ),
  })
  .describe(
    "Project settings kept in the repository: quaso upload stores each one given on the instance, over the value set on the website",
  );
export type RepositorySettings = Infer<typeof RepositorySettings>;
