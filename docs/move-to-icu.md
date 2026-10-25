# Move an i18next project to ICU MessageFormat

Convert a project's source files, translations and pending suggestions from i18next JSON v4 to
ICU MessageFormat at once, when your game moves from i18next's own formatting to an ICU formatter
such as i18next-icu or FormatJS. Translators keep their work: every translation keeps its colour,
author, history and outdated flag, so nothing needs translating or proofreading again.

Turning on **Settings → Placeholders → ICU MessageFormat** by hand converts nothing, and stored
texts such as `{{name}}` then read as broken ICU. Use `quaso convert-to-icu` instead: it converts
the instance and your local source files with the same rules, then turns the setting on.

You need the [CLI](cli.md), a checkout whose source files match the instance's, and an API key
with the `upload` scope that an administrator created (**Account → API keys**). A key from
`quaso token create` on the server works too.

## What changes

| i18next                                  | ICU MessageFormat                                                    |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `Hello {{name}}`, `Hello {{- name}}`     | `Hello {name}`                                                       |
| `coins_one`, `coins_other` (two keys)    | `coins`: `{count, plural, one {{count} coin} other {{count} coins}}` |
| `coins_zero`                             | The exact case `=0 {…}`                                              |
| `place_ordinal_one`, `place_ordinal_two` | `place`: `{count, selectordinal, one {…} two {…} …}`                 |
| `Press {Enter}` (literal braces)         | `Press '{'Enter'}'`                                                  |
| `qu'{{article}}`                         | `qu''{article}`                                                      |
| `#1` in a plural form                    | `'#'1`                                                               |

- Placeholders in your project's own prefix and suffix become `{name}`. Placeholders in extra
  delimiters become `{name}`, and those already written in `{` and `}` stay as they are.
- A plural group becomes one string named by its base, where its first key was. Each language
  keeps its own forms as cases: Polish keeps `one`, `few`, `many` and `other`, Japanese `other`.
  Languages whose plural rules have a `zero` category, such as Arabic and Latvian, keep a `zero`
  case beside `=0`, as i18next used their zero form for those numbers too.
- In the cases, `{{count}}` becomes `{count}`, not `#`: ICU formatters print `{count}` as given,
  as i18next did, while `#` would print a formatted number such as `1,000`.
- Text is quoted where ICU would read it as syntax, so the game shows what it showed before:
  braces, `#` in a plural case, and an apostrophe right before a brace, another apostrophe or
  such a `#`. An apostrophe elsewhere, as in `l'alcalde`, stays single.
- Markdown documents follow the same rules for the whole text, code blocks included.
- Keys in `pluralExclusions` stay separate keys, converted one by one.

## Prepare

1. Fix what ICU MessageFormat can't say. These are refused, and nothing converts until they are
   gone:
   - nesting references such as `$t(common:back)`, including strings made only of them: write
     the text out, or have your game look up the other key;
   - i18next formats such as `{{price, number}}`: format the value in your game before passing
     it, then convert; ICU's `{price, number}` can come later;
   - placeholder names ICU can't hold, such as `{{user.name}}`: use letters, digits and `_`;
   - a plural group whose base is also a key of the same file, such as `coins` beside
     `coins_one` and `coins_other`, or a plural and an ordinal group with the same base: rename
     one of them.
2. Upload the fixed source files, so that the instance and your checkout have the same English:
   `quaso upload --dry-run` changes nothing.
3. Ask translators and reviewers to stop editing, and let translation jobs finish or cancel them.
   The conversion refuses to run while a job is queued or running.

## Preview the conversion

```sh
npx quaso convert-to-icu --dry-run
```

The dry run changes nothing and reports:

- how many strings, translations and pending suggestions would change, and the plural groups
  that would become one string;
- the texts that would get quoted characters, to check that your game needs them;
- refusals, with the file, key and language of each: fix them and run the dry run again;
- translations that would fail the ICU checks. The ICU checks compare each plural case with the
  English case of the same key, which can find problems the i18next checks didn't. Such
  translations are kept, with their errors, and appear under the **QA problems** filter.

Add `--json` for every list in full.

## Convert

```sh
npx quaso convert-to-icu
npx quaso download
```

The first command converts the instance in one step, then rewrites your source files in place:
JSON files keep their indentation and key order, and Markdown files their line endings. It then
checks that `quaso upload` would change nothing. If the files can't be written, run it again: it
finishes the files of a project the instance converted before.

`quaso download` writes every language in ICU MessageFormat. Commit the converted source files and
translations together with your game's switch to an ICU formatter. Until then, keep i18next
uploads away from the instance: an old branch's `quaso upload` would bring back `{{name}}` and the
plural keys. If your config has `translationsInRepository`, download before the next upload, which
imports those files.

## What translators see

- Placeholders read `{name}`, and plural strings show one ICU block with a case per category.
- Each converted text's history shows **Converted to ICU MessageFormat**, by whoever converted it.
  Earlier history entries keep their i18next text.
- Colours, authors, approvers and outdated flags don't change. Pending suggestions stay pending,
  converted too.
- Meaning-check warnings of converted translations are cleared, as after any edit. Run the meaning
  check again if you rely on it.

Strings the English no longer has, hidden files and translations in removed languages stay as
they were. A removed key that a converted plural group now uses keeps its translations, but no
upload brings it back.

## Without the CLI

`POST /api/v1/conversions/icu` with `{"dryRun": true}` returns the same report for the instance
alone, and without `dryRun` converts it. Converting the instance alone leaves your source files in
i18next syntax: convert them before the next upload, for example with `quaso convert-to-icu`,
which then converts only the files. See the [API reference](api.md#convert-to-icu-messageformat).
