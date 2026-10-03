// SPDX-License-Identifier: MIT
/**
 * The HTTP API's contract (design §5.11): request schemas, which the server validates and
 * the OpenAPI document is generated from, and response types, which the CLI and the
 * website use. Paths are relative to `/api/v1`.
 *
 * The service's methods take the same request types, so one set of types describes the
 * HTTP API, the direct call to the service and the internal API with Cloudflare storage.
 */
import type { CheckResult } from "./checks.ts";
import { LanguageTag, LengthLimit, MAX_LENGTH_LIMIT, PluralExclusion } from "./config.ts";
import type { PluralOverride } from "./plurals.ts";
import { type Infer, s } from "./schema.ts";
import {
  type AuthorType,
  type Colour,
  type InterpolationSyntax,
  PLURAL_CATEGORIES,
  type PluralCategory,
  type Role,
  ROLES,
  STATE_FILTERS,
  type SuggestionKind,
  type SuggestionStatus,
  type TextValue,
  TOKEN_SCOPES,
  type TokenScope,
  type TranslatableKind,
} from "./types.ts";

export const API_BASE = "/api/v1";

/** The version of the CLI's `--json` output and of the export format. */
export const SCHEMA_VERSION = 1;

// =======================================================================================
// Shared pieces

/** A translation value: text, or forms by plural category. */
export const TextValueSchema = s
  .union([s.string(), s.record(s.string(), { key: s.enum(PLURAL_CATEGORIES) })])
  .describe("Text, or plural forms by category (zero, one, two, few, many, other)");

/**
 * A file's path below the source folder, such as `common.json` or `menus/main.json`:
 * relative, with `/` separators, no `.` or `..` segments, ending in `.json`.
 */
export const FilePath = s
  .refine(s.string({ minLength: 1, maxLength: 512 }), (path) => {
    if (!path.endsWith(".json")) return "must end with .json";
    if (path.startsWith("/") || path.includes("\\")) return "must be relative, with / separators";
    if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return "must not contain empty, . or .. segments";
    }
    return undefined;
  })
  .describe("A path below the source folder, such as common.json or menus/main.json");

export const FileContent = s.object({
  path: FilePath,
  content: s.string({ maxLength: 20_000_000 }).describe("The file's content, as UTF-8 text"),
});

export const Revision = s
  .integer({ min: 0 })
  .describe(
    "The translation's revision the change is based on (0 when untranslated). A mismatch fails with 409.",
  );

export const Id = s.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

/** Who did something, for display. */
export interface ActorInfo {
  type: AuthorType | "anonymous";
  id: number | null;
  /** The person's display name, the API key's name, the model, "Import" or "System". */
  name: string;
  avatarUrl?: string | null;
}

/** A key in a file, for lists of changes: `{ file: "common.json", key: "menu.play" }`. */
export interface KeyRef {
  file: string;
  key: string;
}

// =======================================================================================
// Errors

export const ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "expired",
  "conflict",
  "qa_failed",
  "invalid_source",
  "rate_limited",
  "payload_too_large",
  "llm_unavailable",
  "budget_exceeded",
  "setup_required",
  "unavailable",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP status for each error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  expired: 410,
  conflict: 409,
  qa_failed: 422,
  invalid_source: 422,
  rate_limited: 429,
  payload_too_large: 413,
  llm_unavailable: 503,
  budget_exceeded: 429,
  setup_required: 403,
  unavailable: 503,
  internal: 500,
};

/** One item of an error's details: whatever applies of file, key, language and check. */
export interface ErrorDetail {
  file?: string;
  key?: string;
  language?: string;
  check?: string;
  value?: string;
  form?: PluralCategory;
  line?: number;
  column?: number;
  /** For validation errors: the path in the request, such as `files[0].path`. */
  path?: string;
  message?: string;
}

/** Every error response: `{ "error": { "code", "message", "details" } }`. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    /** For `conflict` on a translation: the current translation, so the editor can show it. */
    current?: TranslationInfo | null;
  };
}

// =======================================================================================
// Project, languages, files and strings (public reads)

/** Progress counts, for a language or for a file in a language. */
export interface Progress {
  /** Translatable strings. */
  strings: number;
  /** English words in them. */
  words: number;
  untranslated: number;
  green: number;
  blue: number;
  /** Translated (green or blue) but made for older English. */
  outdated: number;
  /** Strings with pending suggestions. */
  pending: number;
  /** Translations with quality check errors. */
  qa: number;
  /** Words of untranslated strings. */
  wordsLeft: number;
  /** Translated words (green and blue) as a percentage of all words, 0–100, rounded down. */
  translatedPercent: number;
  /** Blue words as a percentage of all words, 0–100, rounded down. */
  proofreadPercent: number;
}

export interface LanguageProgress extends Progress {
  tag: string;
  /** The language's name in English, such as "Portuguese (Brazil)". */
  name: string;
  direction: "ltr" | "rtl";
  /**
   * The plural categories the service uses for this language, after the project's override.
   * Runtimes ship different plural data, so the service is the last word: the editor passes
   * these to the quality checks as `pluralOverride`.
   */
  plural: { cardinal: PluralCategory[]; ordinal: PluralCategory[] };
}

export interface ProjectInfo {
  languageRequestsEnabled: boolean;
  name: string;
  description: string;
  sourceLanguage: string;
  sourceLanguageName: string;
  logoUrl: string | null;
  links: { label: string; url: string }[];
  syntax: InterpolationSyntax;
  languages: LanguageProgress[];
  details: {
    strings: number;
    words: number;
    files: number;
    members: number;
    /** Time of the last upload, job or review (ms since the epoch), or null. */
    lastActivity: number | null;
  };
  /** Whether LLM translation is available (a provider is configured). */
  llmAvailable: boolean;
  /** Configured reference languages included in LLM prompts. */
  referenceLanguages: string[];
  /** Goes up on every write; caches use it. */
  revision: number;
}

export interface FileProgress extends Progress {
  id: number;
  path: string;
  repoPath: string;
}

export interface SourceFileInfo {
  id: number;
  path: string;
  repoPath: string;
  strings: number;
  words: number;
  /** The time and project revision of the upload that last changed the source file. */
  updatedAt: number;
  revision: number;
}

export interface SourceFilesResult {
  language?: never;
  files: SourceFileInfo[];
}

/** `GET /files?language=de` */
export interface LanguageFilesResult {
  language: string;
  files: FileProgress[];
}

export type FilesResult = LanguageFilesResult | SourceFilesResult;

export const StringsQuery = s.object({
  language: LanguageTag,
  file: s.string().optional().describe("A file path, or a folder prefix ending in /"),
  state: s.enum(STATE_FILTERS).optional(),
  q: s.string({ maxLength: 200 }).optional().describe("Search in keys, English and translations"),
  ids: s.array(Id, { maxItems: 500 }).optional(),
  cursor: s.string().optional(),
  limit: s.integer({ min: 1, max: 500 }).optional(),
});
export type StringsQuery = Infer<typeof StringsQuery>;

export const StringsQueueQuery = s.object({
  language: StringsQuery.shape.language,
  file: StringsQuery.shape.file,
  state: StringsQuery.shape.state,
  q: StringsQuery.shape.q,
});
export type StringsQueueQuery = Infer<typeof StringsQueueQuery>;

/** IDs in queue order; the first toDo IDs were untranslated or outdated at opening. */
export interface StringsQueue {
  language: string;
  ids: number[];
  toDo: number;
}

export interface TranslationInfo {
  value: TextValue;
  colour: Colour;
  /** Made for older English (STR-4). */
  outdated: boolean;
  /** Goes up on every change; writes send it back (409 on a mismatch). */
  revision: number;
  qa: { errors: number; warnings: number };
  author: ActorInfo;
  approver: ActorInfo | null;
  updatedAt: number;
}

export interface StringSummary {
  id: number;
  fileId: number;
  file: string;
  /** The key path displayed with dots, such as `menu.play` or `hints.0`. */
  key: string;
  kind: TranslatableKind;
  source: TextValue;
  description: string;
  maxLength: number | null;
  /** The limit comes from the CLI config and can't be changed on the website. */
  maxLengthLocked: boolean;
  words: number;
  /** The translation in the requested language, or null (red). */
  translation: TranslationInfo | null;
  /** Pending suggestions in the requested language. */
  pending: number;
  /** The last LLM failure for this string and language, if it still stands. */
  llmFailure: string | null;
}

/** `GET /strings` */
export interface StringsPage {
  language: string;
  strings: StringSummary[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** All strings matching the filters. */
  total: number;
}

export interface ReferenceHint {
  raw: string;
  /** The English text the reference points to, when the key is found. */
  english: string | null;
}

/** `GET /strings/{id}?language=de` */
export interface StringDetail extends StringSummary {
  language: string;
  /** Pending suggestions, and those reviewed in the last 30 days. */
  suggestions: SuggestionInfo[];
  /** The same string in the project's other languages. */
  otherLanguages: { language: string; name: string; translation: TranslationInfo | null }[];
  /** Nesting references in the English, with what they refer to. */
  references: ReferenceHint[];
  /** Checks of the current translation, if any. */
  checks: CheckResult[];
  /** Matching glossary terms for the requested language. */
  glossary: GlossaryTerm[];
}

export const HISTORY_EVENTS = [
  "source_added",
  "source_changed",
  "source_removed",
  "source_restored",
  "source_renamed",
  "translation_saved",
  "translation_llm",
  "translation_imported",
  "translation_approved",
  "translation_unapproved",
  "translation_deleted",
  "suggestion_created",
  "suggestion_approved",
  "suggestion_rejected",
  "suggestion_withdrawn",
  "suggestion_superseded",
] as const;
export type HistoryEvent = (typeof HISTORY_EVENTS)[number];

export interface HistoryEntry {
  id: number;
  stringId: number;
  /** Null for changes to the English. */
  language: string | null;
  event: HistoryEvent;
  before: TextValue | null;
  after: TextValue | null;
  beforeColour: Colour | null;
  afterColour: Colour | null;
  actor: ActorInfo;
  /** Extra facts: the model and request for LLM changes, the suggestion, the comment. */
  detail: Record<string, unknown> | null;
  createdAt: number;
}

/** `GET /strings/{id}/history?language=de` */
export interface HistoryResult {
  entries: HistoryEntry[];
}

export interface ActivityItem {
  id: string;
  type: "upload" | "job" | "review" | "import" | "rename" | "secret";
  at: number;
  actor: ActorInfo;
  summary: string;
  detail: Record<string, unknown>;
}

/** `GET /activity?cursor=` */
export interface ActivityResult {
  items: ActivityItem[];
  nextCursor: string | null;
}

// =======================================================================================
// Upload, download, status and import (the CLI)

export const Rename = s.object({
  file: FilePath.optional().describe("The file; may be left out when the key is unique"),
  from: s
    .string({ minLength: 1 })
    .describe(
      "The old key, displayed with dots; add #text, #plural or #ordinal, or give a JSON array key path, when several strings share it",
    ),
  to: s.string({ minLength: 1 }).describe("The new key, in the same forms"),
});
export type Rename = Infer<typeof Rename>;

/** A repository path is display metadata, separate from the server identity. */
export const RepoPath = s
  .refine(FilePath, (path) => (/^[A-Za-z]:/.test(path) ? "must be relative" : undefined))
  .describe("The file's path relative to quaso.config.json, for display");

/** `POST /sources` */
export const UploadRequest = s.object({
  files: s.array(s.object({ ...FileContent.shape, repoPath: RepoPath })),
  partial: s
    .boolean()
    .optional()
    .describe(
      "Only some files are named (quaso upload --file): files missing from the upload stay",
    ),
  dryRun: s.boolean().optional(),
  sourceLanguage: LanguageTag.optional().describe(
    "The config's source language; must match the instance's once it has strings",
  ),
  languages: s.array(LanguageTag).optional().describe("Languages the instance should have"),
  renames: s.array(Rename).optional(),
  limits: s.array(LengthLimit).optional(),
  pluralExclusions: s.array(PluralExclusion).optional(),
});
export type UploadRequest = Infer<typeof UploadRequest>;

export interface UploadFileResult {
  path: string;
  status: "new" | "updated" | "unchanged" | "restored" | "hidden";
  added: number;
  changed: number;
  removed: number;
  restored: number;
  moved: number;
  unchanged: number;
}

export interface UploadResult {
  dryRun: boolean;
  /** Null for a dry run or an upload that changed nothing. */
  uploadId: number | null;
  files: UploadFileResult[];
  added: KeyRef[];
  changed: KeyRef[];
  removed: KeyRef[];
  restored: KeyRef[];
  renamed: { file: string; from: string; to: string }[];
  /** A removed key and an added key with the same English: probably a rename (STR-6). */
  renameSuggestions: { file: string; from: string; to: string }[];
  /** Files hidden because a full upload didn't include them. */
  hiddenFiles: string[];
  languagesAdded: string[];
  /** Things to know that didn't stop the upload, such as a limit for a key that doesn't exist. */
  warnings: string[];
  /** The automatic translation job this upload queued (LLM-3), if any. */
  job: { id: number } | null;
  revision: number;
}

export const PublicationTime = s
  .refine(s.string({ minLength: 16, maxLength: 35 }), (value) => {
    const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value);
    const time = Date.parse(value);
    if (!utc || !Number.isFinite(time)) return "must be an ISO timestamp in UTC, ending in Z";
    if (new Date(time).toISOString().slice(0, 16) !== value.slice(0, 16))
      return "must be a valid date and time";
    return undefined;
  })
  .describe("A UTC time, such as 2026-09-01T00:00Z");

export const FileVersionsQuery = s.object({ file: FilePath, language: LanguageTag });
export const FileVersionQuery = s.object({ file: FilePath, id: Id });

export interface FileVersionInfo {
  id: number;
  language: string;
  file: string;
  sha256: string;
  size: number;
  revision: number;
  publishedAt: number;
  replacedAt: number | null;
}
export interface FileVersionsResult {
  versions: FileVersionInfo[];
}
export interface FileVersionResult {
  version: FileVersionInfo;
  content: string;
}

export const ExportQuery = s.object({
  languages: s.array(LanguageTag).optional(),
  files: s.array(FilePath).optional(),
  at: PublicationTime.optional(),
});
export type ExportQuery = Infer<typeof ExportQuery>;

export interface ExportFile {
  /** The file's path below the source folder. The CLI maps it to a local path itself. */
  path: string;
  language: string;
  content: string;
  /** SHA-256 of the content's UTF-8 bytes, in hex. */
  sha256: string;
}

/** `GET /export?languages=de,fr&files=common.json` */
export interface ExportResult {
  schemaVersion: number;
  revision: number;
  sourceLanguage: string;
  files: ExportFile[];
}

/** `GET /status?language=de` */
export interface StatusResult {
  revision: number;
  sourceLanguage: string;
  languages: (LanguageProgress & { files: FileProgress[] })[];
}

/** `POST /imports` */
export const ImportRequest = s.object({
  language: LanguageTag,
  files: s.array(FileContent, { minItems: 1 }),
  as: s.enum(["green", "blue"]),
  overwrite: s.boolean().optional().describe("Also replace blue (proofread) translations"),
  keepIdentical: s.boolean().optional().describe("Keep values identical to the English"),
  dryRun: s.boolean().optional(),
});
export type ImportRequest = Infer<typeof ImportRequest>;

export interface RefusedValue extends KeyRef {
  language: string;
  checks: CheckResult[];
}

export interface ImportResult {
  dryRun: boolean;
  language: string;
  /** Written (new or changed). */
  imported: number;
  /** Already there with the same value and colour. */
  unchanged: number;
  skippedIdentical: number;
  /** Blue translations left alone (no `overwrite`). */
  skippedBlue: number;
  refused: RefusedValue[];
  /** Keys in the files that the English doesn't have. */
  unknownKeys: KeyRef[];
  /** Files the instance doesn't know. */
  unknownFiles: string[];
}

// =======================================================================================
// LLM jobs and usage

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled", "paused"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JobScope = s.object({
  languages: s.array(LanguageTag).optional().describe("Default: every language"),
  files: s.array(FilePath).optional().describe("Default: every file"),
  strings: s.array(Id, { maxItems: 5000 }).optional().describe("Only these strings"),
  retranslate: s
    .boolean()
    .optional()
    .describe("Also re-translate green strings (never blue ones, LLM-4)"),
  outdated: s
    .boolean()
    .optional()
    .describe(
      "Update outdated green translations and propose updates for outdated blue ones (default true)",
    ),
  instruction: s
    .string({ maxLength: 4000 })
    .optional()
    .describe("A custom instruction for this run"),
  model: s.string({ maxLength: 200 }).optional(),
});
export type JobScope = Infer<typeof JobScope>;

/** `POST /jobs` */
export const CreateJobRequest = JobScope.extend({
  dryRun: s.boolean().optional().describe("Only count the strings and estimate the tokens"),
});
export type CreateJobRequest = Infer<typeof CreateJobRequest>;

export interface JobFailure extends KeyRef {
  stringId: number;
  language: string;
  reason: string;
}

export interface JobInfo {
  id: number;
  status: JobStatus;
  /** Single strings from the editor come first, then upload jobs, then bulk jobs. */
  priority: "string" | "upload" | "bulk";
  scope: JobScope;
  createdBy: ActorInfo;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: {
    /** Strings × languages to process, when last computed. */
    total: number;
    done: number;
    translated: number;
    /** Proposals written for outdated blue translations. */
    proposed: number;
    failed: number;
    /** Dropped because a person changed the string meanwhile. */
    skipped: number;
  };
  tokens: { input: number; output: number; thinking: number };
  failures: JobFailure[];
  /** Why the job failed or paused, such as "Monthly token budget reached". */
  error: string | null;
}

export interface JobEstimate {
  strings: number;
  words: number;
  requests: number;
  languages: { language: string; strings: number; words: number }[];
  /** Work per server file identity, summed across the selected languages. */
  files: { file: string; strings: number; words: number }[];
  estimatedTokens: { input: number; output: number };
}

/** `POST /jobs` returns the job, or the estimate for a dry run. */
export type CreateJobResult =
  | { job: JobInfo; estimate: null }
  | {
      job: null;
      estimate: JobEstimate;
    };

/** `GET /jobs` */
export const JobsQuery = s.object({
  active: s.boolean().optional().describe("Return all queued or running jobs"),
});
export type JobsQuery = Infer<typeof JobsQuery>;

export interface JobsResult {
  jobs: JobInfo[];
}

export const UsageQuery = s.object({
  period: s.enum(["day", "month"]),
  from: s.string().optional().describe("First period, such as 2026-09-01 or 2026-09"),
  to: s.string().optional(),
});
export type UsageQuery = Infer<typeof UsageQuery>;

export interface UsageTotals {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface UsageRow extends UsageTotals {
  /** `2026-09-24` or `2026-09`. */
  period: string;
  byLanguage: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
}

/** `GET /usage?period=day` */
export interface UsageResult {
  period: "day" | "month";
  rows: UsageRow[];
  budget: { monthlyTokens: number | null; usedThisMonth: number; paused: boolean };
}

// =======================================================================================
// Translations, suggestions and review (people)

/** `PUT /strings/{id}/translations/{lang}`: a manager's save, blue. */
export const SaveTranslationRequest = s.object({ value: TextValueSchema, baseRevision: Revision });
export type SaveTranslationRequest = Infer<typeof SaveTranslationRequest>;

/** `POST /strings/{id}/translations/{lang}/approve`, `…/unapprove`, and `DELETE …`. */
export const TranslationActionRequest = s.object({ baseRevision: Revision });
export type TranslationActionRequest = Infer<typeof TranslationActionRequest>;

/** `POST /strings/{id}/suggestions/{lang}`: a contributor's pending change. */
export const SuggestRequest = s.object({
  kind: s
    .enum(["translation", "correction", "approval"])
    .describe('approval is "Looks good" for a green translation, without a value'),
  value: TextValueSchema.optional(),
  baseRevision: Revision,
});
export type SuggestRequest = Infer<typeof SuggestRequest>;

export interface SuggestionInfo extends KeyRef {
  id: number;
  stringId: number;
  language: string;
  kind: SuggestionKind;
  value: TextValue | null;
  status: SuggestionStatus;
  author: ActorInfo;
  reviewer: ActorInfo | null;
  comment: string | null;
  createdAt: number;
  reviewedAt: number | null;
  /** The translation's revision when the suggestion was made. */
  baseRevision: number;
  /** For the review queue's diff: the English and the current translation. */
  source: TextValue;
  current: TranslationInfo | null;
  checks: CheckResult[];
}

export const SuggestionsQuery = s.object({
  language: LanguageTag.optional(),
  file: s.string().optional(),
  author: s.string().optional().describe('A user ID, or "me"'),
  status: s.enum(["pending", "approved", "rejected", "superseded", "withdrawn", "all"]).optional(),
  kind: s.enum(["translation", "correction", "approval", "llm"]).optional(),
  cursor: s.string().optional(),
  limit: s.integer({ min: 1, max: 500 }).optional(),
});
export type SuggestionsQuery = Infer<typeof SuggestionsQuery>;

/** `GET /suggestions` */
export interface SuggestionsPage {
  suggestions: SuggestionInfo[];
  nextCursor: string | null;
  total: number;
}

/** `POST /suggestions/review` */
export const ReviewRequest = s.object({
  ids: s.array(Id, { minItems: 1, maxItems: 1000 }),
  action: s.enum(["approve", "reject"]),
  comment: s.string({ maxLength: 4000 }).optional(),
});
export type ReviewRequest = Infer<typeof ReviewRequest>;

export interface ReviewResult {
  approved: number[];
  rejected: number[];
  failed: { id: number; code: ErrorCode; message: string; checks?: CheckResult[] }[];
}

/** `PATCH /strings/{id}` (administrators) */
export const UpdateStringRequest = s.object({
  description: s.string({ maxLength: 4000 }).optional(),
  maxLength: s.integer({ min: 1, max: MAX_LENGTH_LIMIT }).nullable().optional(),
});
export type UpdateStringRequest = Infer<typeof UpdateStringRequest>;

/** `POST /renames` (administrators): moves translations and history to a new key (STR-6). */
export const RenameRequest = Rename.extend({ file: FilePath });
export type RenameRequest = Infer<typeof RenameRequest>;

// =======================================================================================
// Sign-in, accounts, volunteers and the team

export const Email = s
  .refine(s.string({ minLength: 3, maxLength: 254 }), (email) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? undefined : "must be an email address",
  )
  .describe("An email address");

export const Password = s
  .string({ minLength: 10, maxLength: 256 })
  .describe("At least 10 characters");

export const DisplayName = s.string({ minLength: 1, maxLength: 80 });

export interface VolunteerRequestInfo {
  status: "pending" | "approved" | "rejected";
  languages: string[];
  message: string;
  createdAt: number;
}

export interface UserInfo {
  id: number;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  /** The languages the role is limited to (ROLE-3), or null for all. */
  languages: string[] | null;
  emailVerified: boolean;
  hasPassword: boolean;
  identities: { provider: "github" | "discord"; username: string | null }[];
  volunteerRequest: VolunteerRequestInfo | null;
  createdAt: number;
}

/** `GET /auth/session` */
export interface SessionInfo {
  user: UserInfo | null;
  /** No administrator yet: the setup page creates one. */
  setupRequired: boolean;
  setupKeyConfigured?: boolean;
  /** A development instance (`bun run dev`), with the one-click login. */
  dev: boolean;
  providers: {
    github: boolean;
    discord: boolean;
    /** An email service is set up: verification, reset and sign-in links by email. */
    email: boolean;
  };
  /** An optional human check for sign-up and volunteer forms. */
  humanCheck: { provider: "turnstile"; siteKey: string } | null;
}

export const SignUpRequest = s.object({
  email: Email,
  password: Password,
  displayName: DisplayName,
  invite: s.string().optional().describe("An invite link's token"),
  humanCheck: s.string().optional(),
});
export type SignUpRequest = Infer<typeof SignUpRequest>;

export const SignInRequest = s.object({ email: Email, password: s.string({ maxLength: 256 }) });
export type SignInRequest = Infer<typeof SignInRequest>;

export const SetupRequest = s.object({
  token: s.string({ minLength: 1 }),
  email: Email,
  password: Password,
  displayName: DisplayName,
  projectName: s.string({ minLength: 1, maxLength: 120 }),
  sourceLanguage: LanguageTag.optional(),
});
export type SetupRequest = Infer<typeof SetupRequest>;

export const EmailRequest = s.object({ email: Email });
export type EmailRequest = Infer<typeof EmailRequest>;

export const TokenRequest = s.object({ token: s.string({ minLength: 1 }) });
export type TokenRequest = Infer<typeof TokenRequest>;

export const ResetPasswordRequest = s.object({
  token: s.string({ minLength: 1 }),
  password: Password,
});
export type ResetPasswordRequest = Infer<typeof ResetPasswordRequest>;

/** `PATCH /account` */
export const UpdateAccountRequest = s.object({
  displayName: DisplayName.optional(),
  email: Email.optional(),
  password: Password.optional(),
  currentPassword: s
    .string({ maxLength: 256 })
    .optional()
    .describe(
      "Needed to change the email address or the password, when the account has a password",
    ),
});
export type UpdateAccountRequest = Infer<typeof UpdateAccountRequest>;

/** `DELETE /account` */
export const DeleteAccountRequest = s.object({
  confirm: s.literal("delete"),
  password: s.string({ maxLength: 256 }).optional(),
});
export type DeleteAccountRequest = Infer<typeof DeleteAccountRequest>;

/** `POST /volunteer-requests` */
export const VolunteerRequest = s.object({
  languages: s.array(LanguageTag, { minItems: 1, unique: true }),
  message: s.string({ maxLength: 4000 }),
  humanCheck: s.string().optional(),
});
export type VolunteerRequest = Infer<typeof VolunteerRequest>;

export interface MemberInfo {
  id: number;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  role: Role;
  languages: string[] | null;
  createdAt: number;
  /** Suggestions sent and translations saved. */
  contributions: number;
  volunteerRequest: VolunteerRequestInfo | null;
}

/** `GET /team/members` and `GET /team/volunteer-requests` */
export interface MembersResult {
  members: MemberInfo[];
}

/** `PATCH /team/members/{id}` */
export const UpdateMemberRequest = s.object({
  role: s.enum(ROLES).optional(),
  languages: s.array(LanguageTag, { unique: true }).nullable().optional(),
});
export type UpdateMemberRequest = Infer<typeof UpdateMemberRequest>;

/** `POST /team/volunteer-requests/{userId}` */
export const ReviewVolunteerRequest = s.object({
  approve: s.boolean(),
  role: s.enum(["contributor", "manager"]).optional(),
  languages: s.array(LanguageTag, { unique: true }).nullable().optional(),
});
export type ReviewVolunteerRequest = Infer<typeof ReviewVolunteerRequest>;

export interface InviteInfo {
  id: number;
  role: Role;
  languages: string[] | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: ActorInfo | null;
  createdBy: ActorInfo;
  /** Only when it was just created: the link to pass on. */
  url?: string;
}

/** `POST /team/invites` */
export const CreateInviteRequest = s.object({
  role: s.enum(["contributor", "manager", "administrator"]),
  languages: s.array(LanguageTag, { unique: true }).nullable().optional(),
});
export type CreateInviteRequest = Infer<typeof CreateInviteRequest>;

/** `GET /invites/{token}`: whether an invite link is still valid, for the sign-up page. */
export interface InviteCheck {
  valid: boolean;
  role: Role | null;
  languages: string[] | null;
}

/** `POST /team/members/{id}/reset-link` */
export interface ResetLink {
  url: string;
  expiresAt: number;
}

// =======================================================================================
// Settings, languages, files and API keys (administrators)

export const PROMPT_PLACEHOLDERS = [
  "%sourceLanguage%",
  "%targetLanguage%",
  "%projectName%",
  "%projectDescription%",
  "%projectInstructions%",
  "%languageInstructions%",
  "%fileName%",
  "%fileContext%",
  "%pluralForms%",
  "%otherLanguages%",
  "%identicalStrings%",
  "%glossary%",
  "%neighbours%",
  "%strings%",
  "%customInstruction%",
] as const;

export const LlmSettings = s.object({
  autoTranslate: s.boolean().describe("Translate new and changed strings on upload (LLM-3)"),
  updateOutdated: s.boolean().describe("On upload, update outdated green translations too"),
  proposeForProofread: s
    .boolean()
    .describe("Propose updates for outdated blue translations, as pending suggestions"),
  model: s.string({ minLength: 1, maxLength: 200 }),
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
      .describe("Proofread translations of identical English strings elsewhere in the project"),
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
export const TestEmailRequest = s.object({ to: Email });
export type TestEmailRequest = Infer<typeof TestEmailRequest>;
export interface EmailTestResult {
  ok: true;
  keyUpdatedAt: number;
}

export const ProjectSettings = s.object({
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.string({ maxLength: 20_000 }),
  sourceLanguage: LanguageTag,
  syntax: s.object({
    prefix: s.string({ minLength: 1, maxLength: 10 }),
    suffix: s.string({ minLength: 1, maxLength: 10 }),
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

/** Provider credentials are writable; only their status is readable. */
export const ManagedSecretName = s.enum(["gemini_api_key", "email_api_key"]);
export type ManagedSecretName = Infer<typeof ManagedSecretName>;
export const SetSecretRequest = s.object({
  value: s.refine(s.string({ minLength: 1, maxLength: 8192 }), (value) =>
    value.trim() === value ? undefined : "must not have leading or trailing whitespace",
  ),
});
export type SetSecretRequest = Infer<typeof SetSecretRequest>;
export interface SecretStatus {
  name: ManagedSecretName;
  set: boolean;
  ending: string | null;
  updatedAt: number | null;
}
export interface SecretsResult {
  secrets: SecretStatus[];
  /** Credentials omitted from a backup that still need to be entered after restoring it. */
  missingSecrets: ManagedSecretName[];
}

export interface LlmTestResult {
  ok: true;
  models: string[];
  keyUpdatedAt: number;
}

export interface SettingsResult {
  settings: ProjectSettings;
  defaultPromptTemplate: string;
  languages: LanguageSettings[];
  files: { id: number; path: string; context: string; generatedContext: string | null }[];
  /** Models the provider offers, for the model picker; empty without a provider. */
  models: string[];
  llmAvailable: boolean;
}

export interface LanguageSettings {
  tag: string;
  name: string;
  direction: "ltr" | "rtl";
  instructions: string;
  pluralOverride: PluralOverride | null;
  /** The categories in use, after the override. */
  categories: { cardinal: PluralCategory[]; ordinal: PluralCategory[] };
}

export const PluralOverrideSchema = s.object({
  cardinal: s.array(s.enum(PLURAL_CATEGORIES), { unique: true }).optional(),
  ordinal: s.array(s.enum(PLURAL_CATEGORIES), { unique: true }).optional(),
});

/** `POST /languages` */
export const AddLanguageRequest = s.object({ tag: LanguageTag });
export type AddLanguageRequest = Infer<typeof AddLanguageRequest>;

/** `PATCH /languages/{tag}` */
export const UpdateLanguageRequest = s.object({
  instructions: s.string({ maxLength: 20_000 }).optional(),
  pluralOverride: PluralOverrideSchema.nullable().optional(),
});
export type UpdateLanguageRequest = Infer<typeof UpdateLanguageRequest>;

/** `PATCH /files/{id}` */
export const UpdateFileRequest = s.object({
  context: s.string({ maxLength: 20_000 }).optional(),
});
export type UpdateFileRequest = Infer<typeof UpdateFileRequest>;

/** `POST /languages`: the new language, and warnings such as missing plural rules. */
export interface AddLanguageResult {
  language: LanguageSettings;
  warnings: string[];
}

/** `PATCH /files/{id}`: the file as the Settings page shows it. */
export type FileSettings = SettingsResult["files"][number];

/** `PATCH /strings/{id}` */
export interface UpdateStringResult {
  id: number;
  description: string;
  maxLength: number | null;
  maxLengthLocked: boolean;
}

/** `POST /renames`: the rename made (none when it was made before). */
export interface RenameResult {
  renamed: { file: string; from: string; to: string }[];
  revision: number;
}

/**
 * `GET /backup?format=json`: the whole instance (OPS-2). Every table's rows, as objects by
 * column name; blobs as `{ "$base64": "…" }`. Sessions, email tokens and secrets are left out.
 */
export interface BackupDocument {
  format: "quaso-backup";
  version: 1;
  /** The database schema version the rows fit. */
  schemaVersion: number;
  createdAt: number;
  revision: number;
  tables: Record<string, Record<string, unknown>[]>;
}

/** `POST /restore`, and `quaso restore <file>`: what was restored. */
export interface RestoreResult {
  schemaVersion: { from: number; to: number };
  /** Rows restored, by table. */
  tables: Record<string, number>;
  revision: number;
  missingSecrets: ManagedSecretName[];
}

export interface ApiTokenInfo {
  id: number;
  name: string;
  scope: TokenScope;
  /** The first characters of the key, such as `qso_Ab3d`, to recognize it. */
  prefix: string;
  createdAt: number;
  createdBy: ActorInfo | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** `POST /api-tokens` */
export const CreateApiTokenRequest = s.object({
  name: s.string({ minLength: 1, maxLength: 80 }),
  scope: s.enum(TOKEN_SCOPES),
});
export type CreateApiTokenRequest = Infer<typeof CreateApiTokenRequest>;

/** The new key, shown once. */
export interface CreatedApiToken extends ApiTokenInfo {
  secret: string;
}

/** `GET /api-tokens` */
export interface ApiTokensResult {
  tokens: ApiTokenInfo[];
}

/** `GET /admin` */
export interface AdminInfo {
  version: string;
  setup: "local" | "cloudflare";
  startedAt: number;
  database: { schemaVersion: number; sizeBytes: number | null; revision: number };
  recentErrors: { at: number; message: string; requestId?: string }[];
  jobs: { queued: number; running: number; paused: number };
  llm: {
    provider: "gemini" | "fake" | null;
    model: string;
    lastSuccessAt: number | null;
    lastError: { at: number; message: string } | null;
  };
  usageThisMonth: UsageTotals;
  lastBackup: { at: number; file: string | null } | null;
}

// =======================================================================================
// Later: glossary, comments, language requests (LATER-1 to LATER-3)

export interface GlossaryTerm {
  id: number;
  term: string;
  /** Null means every language. */
  language: string | null;
  kind: "translate" | "keep";
  translation: string | null;
  caseSensitive: boolean;
  note: string;
  createdBy: ActorInfo | null;
  createdAt: number;
  updatedAt: number;
}
export const GlossaryQuery = s.object({
  stringId: Id.optional().describe("Only terms occurring in this source string"),
  language: LanguageTag.optional(),
  q: s.string({ maxLength: 200 }).optional(),
});
export type GlossaryQuery = Infer<typeof GlossaryQuery>;
export interface GlossaryResult {
  terms: GlossaryTerm[];
}
export const CreateGlossaryTermRequest = s.object({
  term: s.string({ minLength: 1, maxLength: 200 }),
  language: LanguageTag.nullable().optional(),
  kind: s.enum(["translate", "keep"]),
  translation: s.string({ maxLength: 500 }).nullable().optional(),
  caseSensitive: s.boolean().optional(),
  note: s.string({ maxLength: 2000 }).optional(),
});
export type CreateGlossaryTermRequest = Infer<typeof CreateGlossaryTermRequest>;
export const UpdateGlossaryTermRequest = s.object({
  term: s.string({ minLength: 1, maxLength: 200 }).optional(),
  language: LanguageTag.nullable().optional(),
  kind: s.enum(["translate", "keep"]).optional(),
  translation: s.string({ maxLength: 500 }).nullable().optional(),
  caseSensitive: s.boolean().optional(),
  note: s.string({ maxLength: 2000 }).optional(),
});
export type UpdateGlossaryTermRequest = Infer<typeof UpdateGlossaryTermRequest>;

export interface CommentInfo {
  id: number;
  stringId: number;
  file: string;
  key: string;
  /** Null means the English. */
  language: string | null;
  body: string;
  sourceIssue: boolean;
  resolvedAt: number | null;
  resolvedBy: ActorInfo | null;
  author: ActorInfo;
  createdAt: number;
}
export const CommentsQuery = s.object({
  language: LanguageTag.optional(),
  sourceIssue: s.boolean().optional(),
  resolved: s.boolean().optional(),
  cursor: s.string({ maxLength: 20 }).optional(),
  limit: s.integer({ min: 1, max: 200 }).optional(),
});
export type CommentsQuery = Infer<typeof CommentsQuery>;
export interface CommentsPage {
  comments: CommentInfo[];
  nextCursor: string | null;
  total: number;
}
export const CreateCommentRequest = s.object({
  body: s.string({ minLength: 1, maxLength: 4000 }),
  language: LanguageTag.nullable().optional(),
  sourceIssue: s.boolean().optional(),
});
export type CreateCommentRequest = Infer<typeof CreateCommentRequest>;

export interface LanguageRequestInfo {
  id: number;
  tag: string;
  name: string;
  message: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: ActorInfo | null;
  votes: number;
  /** Whether the caller has voted; anonymous visitors never have. */
  voted: boolean;
  createdAt: number;
  reviewedAt: number | null;
  reviewedBy: ActorInfo | null;
}
export interface LanguageRequestsResult {
  requests: LanguageRequestInfo[];
}
export const CreateLanguageRequestRequest = s.object({
  tag: LanguageTag,
  message: s.string({ maxLength: 500 }).optional(),
  humanCheck: s.string({ maxLength: 4000 }).optional(),
});
export type CreateLanguageRequestRequest = Infer<typeof CreateLanguageRequestRequest>;
export const ReviewLanguageRequestRequest = s.object({ action: s.enum(["approve", "reject"]) });
export type ReviewLanguageRequestRequest = Infer<typeof ReviewLanguageRequestRequest>;
