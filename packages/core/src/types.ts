// SPDX-License-Identifier: MIT
/**
 * Domain types shared by every package: the service, the server, the CLI and the website.
 */

/**
 * The path of an entry in a JSON file: object keys and array indices from the root, such
 * as `["settings", "soundVolume"]` or `["hints", 0]`. A list, not a dotted string, so keys
 * that contain dots stay unambiguous (design §5.2).
 */
export type KeyPath = (string | number)[];

/** Plural categories, in CLDR order. */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** The forms of a plural string, by category, such as `{ one: "…", other: "…" }`. */
export type PluralForms = Partial<Record<PluralCategory, string>>;

/**
 * What an English entry is (design §5.2):
 * - `text`: a string translators translate;
 * - `plural` and `ordinal`: a plural group (`coins_one`, `coins_other`), translated as one
 *   string with a form per category;
 * - `reference`: a string made only of nesting references (`$t(common:back)`), copied as is;
 * - `literal`: a number, boolean, null, empty or blank string, or empty object or array,
 *   copied as is.
 */
export type EntryKind = "text" | "plural" | "ordinal" | "reference" | "literal";

/** The kinds translators see and translate. */
export type TranslatableKind = "text" | "plural" | "ordinal";

export const TRANSLATABLE_KINDS: readonly TranslatableKind[] = ["text", "plural", "ordinal"];

export function isTranslatable(kind: EntryKind): kind is TranslatableKind {
  return kind === "text" || kind === "plural" || kind === "ordinal";
}

/** A translatable value: text for `text`, forms for `plural` and `ordinal`. */
export type TextValue = string | PluralForms;

/** The delimiters around a placeholder, such as `{{` and `}}`. */
export interface Delimiters {
  prefix: string;
  suffix: string;
}

/** The interpolation syntax of a project (i18next's `interpolation.prefix` and `suffix`). */
export interface InterpolationSyntax {
  prefix: string;
  suffix: string;
  /**
   * Delimiters of placeholders the app fills in itself, besides i18next's: `{` and `}` for
   * `{name}`. Their placeholders are checked and kept like i18next's; the whole text between
   * the delimiters is the name.
   */
  extra?: Delimiters[];
}

export const DEFAULT_SYNTAX: InterpolationSyntax = { prefix: "{{", suffix: "}}" };

/** Colours of a translation (STR-1). No translation is red. */
export type Colour = "green" | "blue";

/**
 * The state of a string in one language, for filters and display. `red` means
 * untranslated. `outdated`, `pending` and `qa` are flags on top of the colour.
 */
export type StringState = "red" | "green" | "blue";

/** Filters for the string list (design §5.9). */
export const STATE_FILTERS = [
  "untranslated",
  "green",
  "blue",
  "outdated",
  "pending",
  "qa",
] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

/** Roles (ROLE-2). `none` is a signed-in person without a role. */
export const ROLES = ["none", "contributor", "manager", "administrator"] as const;
export type Role = (typeof ROLES)[number];

/** API key scopes (OPS-3): `read` downloads and reads status; `upload` also uploads, imports and translates. */
export const TOKEN_SCOPES = ["read", "upload"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Kinds of pending changes (STR-2). */
export const SUGGESTION_KINDS = ["translation", "correction", "approval", "llm"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "superseded",
  "withdrawn",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** Who wrote a translation or made a change. */
export type AuthorType = "user" | "llm" | "import" | "token" | "system";

/** Formats a key path for display: `settings.soundVolume`, `hints.0`. */
export function formatKeyPath(path: KeyPath): string {
  return path.map(String).join(".");
}

/**
 * The identity of an entry within its file, as stored in the database (STR-3): the key
 * path as JSON, with a suffix for plural groups, so that a plural group `coins`
 * (`coins_one`, `coins_other`) can't collide with a plain key `coins`, and a cardinal and an
 * ordinal group with the same base stay apart.
 */
export function entryKey(kind: EntryKind, keyPath: KeyPath): string {
  const json = JSON.stringify(keyPath);
  if (kind === "plural") return `${json}#plural`;
  if (kind === "ordinal") return `${json}#ordinal`;
  return json;
}
