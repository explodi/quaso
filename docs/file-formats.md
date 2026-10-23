# Supported files and translation checks

Quaso reads and writes i18next JSON v4 files and Markdown documents. Use this reference to prepare source files, understand
plural forms and placeholders, and resolve translation checks.

## Source file structure

A JSON source file must contain an object. Quaso reads nested objects and arrays, and keeps their
key order. It rejects invalid JSON and duplicate keys. JSON comments and trailing commas are not
supported.

This is a valid source file:

```json
{
  "menu": {
    "start": "Start game",
    "welcome": "Welcome, {{name}}"
  },
  "coins_one": "One coin",
  "coins_other": "{{count}} coins",
  "hints": ["Open the gate", "Find the key"],
  "back": "$t(common:back)",
  "version": 2
}
```

Quaso translates text that is not blank. It copies numbers, booleans, null values, blank strings, empty
objects and arrays, and strings made only of nesting references. A nesting reference such as
`$t(common:back)` asks i18next to insert another translation.

Keys are identities, not text to translate. A literal key named `menu.start` differs from a key
named `start` inside the `menu` object. Settings that accept key paths can use a JSON array, such
as `["menu.start"]`, when dotted paths would be unclear.

File patterns, language folders, and length limits belong in `quaso.config.json`. Refer to
[Add Quaso to your game](add-to-your-game.md#configure-paths-and-languages) for the file layout and
the [CLI configuration reference](cli.md#the-config-file) for every field.

For JSON sources, upload can read descriptions from an adjacent `.descriptions.json` file or keys
with a configured `descriptionSuffix`. These descriptions give translators context without changing
the source file. See [CLI upload](cli.md#quaso-upload) for details.

## Markdown documents

Files ending in `.md` or `.markdown` are translated as whole documents. Quaso does not split them
into keys or paragraphs: the file is one string with an empty key. Add a file mapping such as
`text/en/**/*.md` to `text/{lang}/{path}` beside your JSON mappings. The editor shows the file name
and a paragraph count. Translation jobs send one document per model request.

Keep the same number of paragraphs, in the same order, and preserve headings, links, and Markdown
syntax. Quaso counts paragraphs as blocks separated by blank lines, instead of the line breaks
within paragraphs. Placeholders, nesting references, and any length limit still apply. Three more
checks run on documents:

- `markdown_verbatim` (error): code blocks, inline code, the URLs of links and images, autolinks
  and front matter keys must stay exactly as in the English. Front matter values, link text and
  image alt text are translated. Links to a heading of the same file (`#…`) are an exception: see
  `heading_anchor`.
- `markdown_structure` (error): each paragraph stays the same kind of block as in the English: a
  heading of the same level, a list, a numbered list, a quote, a table, a code block, front matter
  or a plain paragraph.
- `heading_anchor` (warning): a link to a heading of the same file, such as `(#installation)`,
  leads to no heading of the translation. A translated heading gets a new anchor (`## Installation`
  becomes `#instalación`), so rewrite the link to it, or give the heading an explicit anchor
  (`## Instalación {#installation}`) if your Markdown renderer supports one.

When the English of a translated document changes, the LLM gets the English the translation was
made for along with the new English, and is asked to change only what the English change
requires. Paragraphs whose English didn't change keep their translation exactly, even if the model
reworded them.

The LLM translates a document in one answer, so a document may have at most 6,000 words. Upload
warns about a longer one, and translation jobs skip it with an error. Split such a file, or
translate it in the editor. Measured with `gemini-flash-latest`: 1,600 words took 26 seconds,
6,200 words 78 seconds and 9,200 words 104 seconds, against a limit of 180 seconds per request.
The 6,000-word limit leaves room for slower models.

Quaso removes a byte order mark, converts line endings to line feeds, and removes whitespace at
the end before storing and comparing a document. Downloads add one final newline. Markdown files
do not use JSON description sidecars or description-suffix keys.

## Plural and ordinal forms

Quaso groups sibling keys such as `coins_one` and `coins_other` into one plural string when the
group contains `_other` and at least one other category, and all values are strings. A single
`coins_other` key remains ordinary text. Groups containing only blank strings or nesting
references are copied rather than translated.

Target languages can need different forms from the source language. Quaso uses the categories
reported by its runtime's plural rules: `zero`, `one`, `two`, `few`, `many`, and `other`. The editor
shows the required forms with example numbers. A language's plural override can supply categories
when the runtime's rules do not fit the project.

Ordinal groups use names such as `place_ordinal_one` and `place_ordinal_other`, for text such as
first and second place. If a cardinal source group has an explicit `_zero` form, target languages
also get that form. This extra zero rule does not apply to ordinal groups.

If keys only look like plurals, add the group to `pluralExclusions` in the CLI configuration. For
example, excluding `menu.power` keeps `menu.power_one` and `menu.power_other` as separate strings.
The `key` field is a string. For an exact path, write the path array inside that string, for
example `"key": "[\"menu\", \"power\"]"`.

## Placeholders and nesting references

A **placeholder** is text that your game replaces at runtime, such as `{{name}}` or `{{count}}`.
Keep its name, delimiters, and meaning in the translation. You can move it within the sentence.
The checks compare how often each placeholder appears, along with any format or unescaped form.

Quaso recognizes i18next forms such as `{{price, number}}` and `{{- html}}`. It also recognizes
nesting references such as `$t(common:back)`. References appear as locked tokens in the editor and
LLM requests; their contents must not be translated or changed.

In **Settings → Placeholders**, an administrator can change the main placeholder prefix and suffix,
add extra delimiter pairs, and mark particular placeholders optional for selected languages.
These settings affect Quaso's checks; configure your game to interpret the same syntax.

Plural groups have a special rule for `count`: a form that refers to exactly one number can omit
that placeholder. Do not assume every language's `one` category means only the number 1. Use the
examples and checks shown for that language. ICU plural blocks have the same rule for `#`; refer
to [ICU MessageFormat](#icu-messageformat).

## ICU MessageFormat

If your app uses i18next-icu or another ICU MessageFormat library, turn on **ICU MessageFormat** in
**Settings → Placeholders**. Quaso then reads ICU in JSON strings and in Markdown documents.

The setting applies to the whole project. With it on, `{{name}}` and `$t(…)` are no longer
placeholders or references, and the prefix, suffix and extra delimiters described above are not
used. Turn it on only if your app reads every string as ICU.

Quaso still groups sibling keys such as `coins_one` and `coins_other` into plural strings, and
checks the ICU in each form. If your app uses ICU plural blocks only and some keys merely look like
plural groups, add those keys to `pluralExclusions`.

### Arguments and blocks

Arguments such as `{name}`, `{price, number}` and `{day, date, short}` are placeholders. So is `#`
in a plural case: it stands for the number. A **block** chooses one of its cases by an argument:

```
{style, select,
  masculine {Mayor {name} has started a new term.}
  feminine {Mayor {name} has started a new term.}
  other {{name} has started a new term.}
}
```

Translate only the text inside each case. Keep each block's argument, its type (`select`, `plural`
or `selectordinal`), any `offset:` and, in a select block, its case keys as written. Quaso does not
check `offset:`. Blocks can sit inside the cases of other blocks; the checks compare each level of
nesting in turn.

The editor shows a block's syntax, such as `{n, plural, one {`, in grey monospace in the source
text. Chips above the input insert the arguments of every case.

### Plural blocks

A `plural` block has one case per plural category of the language, not of the English. The English

```
{n, plural, one {# coin} other {# coins}}
```

becomes, in Polish, which has four categories:

```
{n, plural, one {# moneta} few {# monety} many {# monet} other {# monety}}
```

The editor shows each language's categories, with example numbers, for plural strings. A
`selectordinal` block works the same way with ordinal categories: English has `one`, `two`, `few`
and `other` (1st, 2nd, 3rd, 4th), while German only has `other`. A language's plural override
applies to its blocks too.

An exact case such as `=0 {No coins}` covers one number in every language. Keep each exact case of
the English; you may add exact cases the English doesn't have.

Each case is compared with the English case of the same key, or with the English `other` case when
the English has no such key. Polish `few` and `many` therefore need the same placeholders as the
English `other`. A case that covers exactly one number, such as `one` in German or `=1`, may leave
out `#` and the block's argument.

### Checks

- `icu_structure` (error): a block is missing, broken or not in the English, a select block's
  cases differ from the English's, a plural block has a case that isn't a plural category, or an
  exact case such as `=0` is missing. A block with a broken case, such as an unclosed `{`, counts
  as missing.
- `plural_form_missing` and `plural_form_unexpected` (errors): a plural block lacks a case for one
  of the target language's categories, or has a case for a category the language doesn't use.
- `placeholder_missing` and `placeholder_extra` (errors) name the case they are about, such as "in
  the few case of {n, plural}".

### Braces and apostrophes

A `{` that starts no argument, such as one in a code block of a Markdown document, is plain text.
To write a brace that does start one as text, quote it with apostrophes, as ICU does:

- `'{'` and `'}'` are literal braces, and `'#'` is a literal `#` in a plural case.
- `''` is one apostrophe.
- An apostrophe before any other character is just an apostrophe: `l'alcalde` needs no change.
- An apostrophe right before `{` starts quoted text, so `l'{name}` shows `{name}` literally and the
  check reports the placeholder missing. Write `l''{name}`.
- Quoted text that isn't closed with another apostrophe runs to the end of the message.

## Errors and warnings

The editor, translation jobs, and imports use the same core checks. The server makes the final
decision using its language rules.

| Result  | Examples                                                                                                                                                                                                                                                | Effect                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Error   | Missing or extra placeholders, changed nesting references, missing plural forms, a missing or changed ICU block, text over a length limit, changed edge whitespace or line-break counts, a changed document paragraph count, or an invalid value shape. | Normal saves and LLM results are rejected. |
| Warning | Text identical to the source, changed numbers or tags, repeated spaces, changed final punctuation, or a missing glossary term.                                                                                                                          | The value can be saved, but needs review.  |

Blank translations are normally errors. A form can remain blank if its matching source form
is also blank and its whitespace matches after line endings are normalized. An import with `--allow-qa-errors` can retain values with quality errors; this is an explicit
exception, not evidence that the values are valid. Refer to [CLI import](cli.md#quaso-import).

Length limits count characters as readers perceive them, including placeholders and references
as written. They do not measure the width of text on screen. A combined emoji can count as one
character while taking more room than a letter. Check text in the game as well.

Further checks compare accepted translations across a file or project. They warn when different
source strings share a translation, or identical source strings have different translations.
Optional model checks report possible meaning, omission, or grammar problems. These warnings also
appear in the QA filter. A person still needs to judge whether the difference is intended.

Checks do not establish that a translation has the right meaning, tone, or layout.

## Missing translations

By default, downloads use source text when an accepted translation is missing. For a plural form,
Quaso first tries the matching source category, then the source `other` form. This can produce
files containing both source and translated text.

With `untranslated: "omit"` in the CLI configuration, missing text and plural forms are left out.
If an array has an untranslated text or plural entry, Quaso omits that whole outer array rather
than shifting its indexes. Configure and test your game's fallback behavior before using this
option.

An outdated accepted translation is included by default. Set `outdated` to `"omit"` to leave it out,
regardless of the missing-translation setting. For JSON arrays, omission keeps the same whole-array
rule described above.

For Markdown, omitting the only translation leaves no document to write. The CLI removes the local
translation file so the game can fall back to its source. A local edit still prevents that removal
unless you explicitly choose to overwrite it. Empty source documents also produce no output file.

Pending suggestions are never used. Refer to [How translation works](concepts.md#what-a-download-includes)
for release checks and historical downloads.

## Download formatting

Downloaded JSON files follow the source file's key order, indentation, and line endings, and end with a
newline. Plural forms follow the target language's required categories. Quaso writes Unicode
characters directly, so escape spelling can differ from the source file. A byte order mark is not
written back.

The same source, translations, and rendering options produce the same bytes. This does not mean a
translated file is a byte-for-byte copy of the source. The CLI leaves your source files unchanged
and skips writing a downloaded file when its content is unchanged. The [CLI reference](cli.md#quaso-download)
explains local-edit checks and how to keep translation languages owned by the repository.

## Resolve a failed check

Use the error's file, key, and language to find the affected string:

1. If an upload fails, check the source JSON and configuration first. Run `quaso upload --dry-run`
   after fixing them.
2. If a translation fails, compare its placeholders and references with the source. Fill every
   required plural form and check any length limit.
3. If the source changed, review the accepted translation against the new text. Do not remove a
   required placeholder only to keep an older translation.
4. Run `quaso status --fail-on untranslated,outdated` before the next release, and review its QA
   counts separately. The `--fail-on` option does not accept `qa`.
