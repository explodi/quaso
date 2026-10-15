# CLI reference

`quaso` is Quaso's command-line interface (CLI). Use it to upload source files, start translation
jobs, download translations, check progress, and import existing translations. Commands do not
prompt for input. JSON output and exit codes support scripts, continuous integration (CI), and AI
agents. For your first setup, follow [Add Quaso to your game](add-to-your-game.md).

- [Installing](#installing)
- [Connecting to your instance](#connecting-to-your-instance)
- [The config file](#the-config-file)
- [Commands](#commands): [init](#quaso-init), [upload](#quaso-upload), [download](#quaso-download),
  [translate](#quaso-translate), [status](#quaso-status), [import](#quaso-import),
  [version and help](#quaso-version-and-quaso-help)
- [Options for every command](#options-for-every-command)
- [JSON output](#json-output)
- [Exit codes](#exit-codes)
- [Running in CI](#running-in-ci)
- [For AI agents](#for-ai-agents)
- [Safety](#safety)

## Installing

This reference describes the current `main` branch. The examples install the `main` package tag.
For a tagged release, use its matching CLI package and documentation; older releases can lack
options described here.

The CLI runs on Node 22 or later and on Deno 2.9 or later. The published package contains one JavaScript file with no
separate runtime dependencies.

**With npm**, install it in your game and commit the package lockfile so the team and CI use the
same version:

```sh
npm install --save-dev @quaso-i18n/cli@main
npx quaso status
```

Or run a version without installing it: `npx @quaso-i18n/cli@main status`.

**With Deno**, run it from npm:

```sh
deno run -A npm:@quaso-i18n/cli@main status
```

To install a global `quaso` command, run `deno install --global -A --name quaso npm:@quaso-i18n/cli@main`.

Successful main builds publish a version ending in `main.g<commit>` under the npm tag `main`.
The separator is `.` after a version such as `1.0.0-rc.2`, or `-` after a version such as `1.0.0`.
Use the package version for the commit your instance runs. Because `main` moves, keep the package
lockfile and use `npm ci` for later installs.

Deno can hold back npm packages published in the last day. To install a newly published package
in a Deno project, use `deno install --min-dep-age 0`.

## Connecting to your instance

Two environment variables connect the CLI to your team's Quaso instance:

| Variable         | What it is                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUASO_HOSTNAME` | The instance, such as `translate.yourgame.com`. HTTPS is assumed; a full URL such as `http://localhost:8000` also works, for development.                                        |
| `QUASO_API_KEY`  | A key created by an administrator: `read` permits `download` and `status`; `upload` also permits `upload`, `import`, and `translate`. Creator permissions also apply; see below. |

```sh
export QUASO_HOSTNAME=translate.yourgame.com
export QUASO_API_KEY='your API key'
```

Create a key in **Account → API keys**. Replace the example hostname and key with your own
values. A key is limited by both its scope and its creator's current role. An administrator's
key supports the full CLI workflow. A manager's `upload` key can translate in their assigned
languages, but cannot upload, import, download, or run `status`. The key stops working if its creator's
account is deleted.

The key comes only from the environment: the CLI refuses a config file that contains one.
A team that prefers to commit the hostname can put
`"hostname"` in the config file instead; `QUASO_HOSTNAME` wins over it.

The CLI never follows redirects, so your key only goes to the configured host. If the
instance redirects (for example from `http://` to `https://`), the error says which address to use.

## The config file

For source file rules, see [File formats](file-formats.md). The CLI reads `quaso.config.json` from the current folder, or from the nearest parent folder that
has one. That folder is the project folder: source and translation paths are relative to it, and the CLI
never writes outside it. `quaso init` writes a starter file.

```json
{
  "$schema": "https://translate.yourgame.com/schema/config-v1.json",
  "sourceLanguage": "en",
  "languages": ["de", "fr", "it", "es", "pt-BR", "pl", "tr", "ja", "ko", "zh-Hans"],
  "languageMapping": { "zh-Hans": "zh-CN" },
  "files": [
    {
      "source": "src/locales/en/**/*.json",
      "translation": "src/locales/{lang}/{path}",
      "exclude": ["src/locales/en/debug/**"]
    }
  ],
  "limits": [{ "file": "store.json", "key": "title", "maxLength": 30 }],
  "pluralExclusions": [{ "file": "common.json", "key": "menu.power" }]
}
```

| Field                      | Meaning                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`                  | The JSON Schema of the file, which your instance publishes at `/schema/config-v1.json`, for completion and checks in editors. Optional.                                                                                                                                 |
| `hostname`                 | The instance, when `QUASO_HOSTNAME` isn't set. Optional.                                                                                                                                                                                                                |
| `sourceLanguage`           | The language of your source files, as a BCP 47 tag such as `en`.                                                                                                                                                                                                        |
| `languages`                | The languages to translate into: what `download` writes and `status --fail-on` counts. `upload` adds any of them that the instance lacks. Languages that the instance has and the config doesn't list, such as one volunteers are just starting, are left alone.        |
| `descriptionSuffix`        | A suffix for JSON keys that describe another source string, such as `@description`. These description keys are not translated. Optional.                                                                                                                                |
| `translationsInRepository` | Languages authored in the repository. Upload imports their selected local files as blue, replacing the instance's values. Must name target languages.                                                                                                                   |
| `languageMapping`          | The name a language has in your game, when it differs from its tag: `{ "zh-Hans": "zh-CN" }` writes Simplified Chinese to `src/locales/zh-CN/`. Optional.                                                                                                               |
| `files`                    | Where the files are: one or more entries, each with `source`, `translation` and an optional `exclude`.                                                                                                                                                                  |
| `files[].source`           | A glob of the source files, such as `src/locales/en/**/*.json`.                                                                                                                                                                                                         |
| `files[].translation`      | Where translations go, with `{lang}` (the language as your game names it, after `languageMapping`) and `{path}` (the source file's path below the folder where the glob starts).                                                                                        |
| `files[].exclude`          | Globs of source files to leave out, relative to the project folder. Optional.                                                                                                                                                                                           |
| `limits`                   | Maximum lengths, such as for app store fields, in user-perceived characters. `file` is the file's path as the instance knows it (below the folder where the glob starts). They win over limits set on the website. Optional.                                            |
| `pluralExclusions`         | Groups of keys that only look like plurals (`menu.power_one`, `menu.power_other`), named without the category. Optional.                                                                                                                                                |
| `outdated`                 | What `download` writes for translations of an older source: `"write"` (default), or `"omit"` so the app falls back to its source language.                                                                                                                              |
| `untranslated`             | What `download` writes for a string that isn't translated: `"source"` (the default), its source text, so every file has every key; or `"omit"`, nothing, for apps that fall back to the source language themselves (for example, i18next with `fallbackLng`). Optional. |

**Globs** use `/` on every system: `*` matches within a folder, `**` matches any number of folders,
`?` one character, `{a,b}` either alternative, and `[abc]`, `[a-z]` or `[!abc]` one character of a
set. Folders named `node_modules` or starting with a dot are skipped.

**Paths on the instance.** Each source file is known to the instance by its path below the folder
where its glob starts: with `src/locales/en/**/*.json`, the file `src/locales/en/menus/main.json` is
`menus/main.json`, and its German translation goes to `src/locales/de/menus/main.json`. Two source
files can't have the same path on the instance. A single file works too:
`"source": "locales/en.json"` with `"translation": "locales/{lang}.json"`.

**Markdown documents.** Add a file rule such as `"source": "text/en/**/*.md"` with
`"translation": "text/{lang}/{path}"`. Each `.md` or `.markdown` file is one translatable string;
its key is empty because its file path identifies it. `limits`, `pluralExclusions`, and `--rename`
do not apply to documents. See [File formats](file-formats.md) for paragraph checks and output
formatting.

**Translations stay out of the source globs.** A `translation` pattern must not write where a
`source` glob looks, or the next upload would send the German files as English ones. The CLI refuses
such a config (`locales/**/*.json` with `locales/{lang}/{path}`, for example), and `download` checks
every path again before it writes. Add the translations' folders to `exclude`
(`"exclude": ["locales/{de,fr}/**"]`), or give the source files a folder of their own.

**Keys shared by several strings.** When a text key `coins` sits beside the plural group
`coins_one`/`coins_other`, add `#text`, `#plural` or `#ordinal` to name one of them in `limits` and
renames (`coins#plural`), or write the key path as a JSON array, such as `["a.b"]` for a key that
contains a dot. In `--rename`, a key that contains `=` is written as a JSON string, such as
`'common.json:"x = y"=equation'`.

The CLI checks the whole file before it does anything and lists every problem at once, with its
place: `quaso.config.json:3:17: …` for JSON syntax, and
`quaso.config.json › files[0].translation: must contain {lang}` for the rest.

## Commands

### `quaso init`

Writes a starter `quaso.config.json` in the current folder. It never overwrites an existing file.

| Option                              | Meaning                                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--languages <langs>`               | The languages to translate into, such as `de,fr,pl`. Required unless inferred by `--from-crowdin`.                                                              |
| `--from-crowdin [file]`             | Convert Crowdin YAML; default file: `crowdin.yml`. Infer languages from local translation files and language mappings.                                          |
| `--language-mapping <tag=folder,…>` | Existing folder names, such as `zh-Hans=zh,pt-PT=pt`. Repeatable. Tags must be target languages and folders must be distinct safe names.                        |
| `--source <lang>`                   | The source language. Default: `en`.                                                                                                                             |
| `--files <glob>`                    | Where the source files are; `{source}` stands for the source language. Default: `src/locales/{source}/**/*.json`.                                               |
| `--translation <pattern>`           | Where translations go. Default: the `--files` folder named after the source language, replaced by `{lang}`, then `{path}`, such as `src/locales/{lang}/{path}`. |

When `QUASO_HOSTNAME` is set, `$schema` points at the instance's JSON Schema.

```sh
quaso init --languages de,fr,pl
quaso init --languages zh-Hans,pt-PT --language-mapping zh-Hans=zh,pt-PT=pt
quaso init --languages de,ja --files 'public/locales/{source}/*.json'
quaso init --from-crowdin
```

Crowdin conversion prints the generated config and warnings before writing it. Review the
reported fields and language proposals before uploading. It converts `%two_letters_code%`,
`%locale%` and `%language%`, per-file `languages_mapping`, ignore patterns and file paths.
`**/%original_file_name%` preserves nested paths below the source glob's base;
`%original_path%/%original_file_name%` includes that base and requires
`preserve_hierarchy: true`. This behavior follows [Crowdin's path and mapping rules](https://crowdin.github.io/crowdin-cli/advanced).
Layouts that would flatten recursive source paths and unsupported placeholders are reported
and skipped. Conversion fails without writing when no file entries can be converted.

Existing translation files supply target languages; an existing `zh` folder proposes
`zh-Hans` and prints a reminder to check it. Override inferred languages with `--languages`
and folder names with `--language-mapping`. Named-language folders need an explicit mapping.
Crowdin's `base_path` must be `.`; run from the project root. The original YAML is only read,
and its credentials are never copied into the config or printed in YAML errors.

### `quaso upload`

Sends every source file to the instance, unchanged, with the config's languages, limits and plural
exclusions, and prints what was added, changed and removed. The instance parses the files and checks their contents.

Each upload includes two paths: the identity below the source glob's base (`menu.json`) and
its display path relative to `quaso.config.json` (`src/locales/en/menu.json`). Moving that display
path preserves translations and history. Download and import still use the identity path.

| Option                                 | Meaning                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`                            | Compute and show the changes without saving them.                                                                                                                                                                                                                                        |
| `--file <path>`                        | Upload only this file: its path on the instance (`common.json`) or its local path. Repeatable. The other files stay as they are. Without `--file`, files missing from the upload are hidden on the instance (never deleted; they come back with their translations when uploaded again). |
| `--rename <old=new>`                   | Move a key's translations and history to its new name: `old=new`, or `file:old=new` when the key isn't unique. A key with `=` in it is written as a JSON string: `"x = y"=equation`. Repeatable.                                                                                         |
| `--import-translations <lang[:state]>` | Import selected local translation files after upload. State: `blue` (default) or `green`. Repeatable, or a comma list. Existing blue values stay unless the language is in `translationsInRepository`.                                                                                   |
| `--wait`                               | Wait for the automatic translation job the upload queues, if any, as [`quaso translate`](#quaso-translate) does: progress on stderr, then the strings that failed, with exit code 6.                                                                                                     |

When a removed key and an added key have the same source text, the output suggests a rename and prints
the exact command, quoted for the shell:

```text
Possible renames (a removed key and an added key with the same English):
  src/locales/en/common.json › saved → gameSaved
    quaso upload --rename common.json:saved=gameSaved
```

Uploading unchanged source files preserves their revision. A JSON file that has invalid syntax or a duplicate
key, stops the upload with exit code 5 and its place:
`src/locales/en/menus.json:3:19: trailing comma is not allowed`.

When automatic translation is enabled and a Gemini key is configured, upload queues a job for
new and changed strings. Automatic translation is enabled by default. Separate settings control
updates to outdated green translations and proposals for outdated blue translations; both are on
by default. Use `--wait` to wait for the job.

Local translations for new, changed, or restored keys appear in upload output with an import
`quaso import --as blue --language <tag> --file <file>` command. Use
`quaso upload --import-translations es:blue` (or `es:green`) to import selected local files in the
same run. Explicit imports preserve existing blue translations. For a language maintained in your repository,
set `"translationsInRepository": ["es"]`; uploads import its selected files as blue every time,
including unchanged source uploads, replacing the instance's values and keeping text identical to the source.
This config setting takes precedence over `--import-translations` for the same language. Review QA refusals printed by the command; exit code 6 means some values were refused.
Dry runs report the import plan without importing.

Per-string descriptions can live beside the source in `common.descriptions.json`, with matching
nested key paths and text values. Upload sends them as metadata, excludes these description files from source
strings, and reports descriptions whose keys have no source. Both files stay unchanged. For plural
strings, use the group's base key. Alternatively set `"descriptionSuffix": "@description"` and
write `"bridge@description": "The bridge spans the canal"` beside `"bridge"` in the source file;
description keys are excluded from translations and downloaded game files. Descriptions may contain
up to 4,000 characters. Missing entries preserve descriptions written on the website; empty text
clears them. The editor and model prompts receive the saved descriptions.

### `quaso download`

Writes every language's files where the config's `translation` pattern says. Strings that aren't
translated yet are written in the source language, so the game always has every key; with
`"untranslated": "omit"` in the config they are left out instead, as are the plural forms a
translation lacks. An array with an untranslated element is also left out. Configure your app
to fall back to the source language before using `omit`. `--at` refuses both omission settings because it reads stored published files. Files whose content has not changed are left alone: a second download writes nothing.

By default, a normal download reads current accepted translations, including green, blue, and outdated values.
It does not wait for publication and does not include pending suggestions. Use
`status --fail-on outdated,green` if your release requires current, proofread translations.

Downloads list every older-source translation included, with its language, file, key and the
source file's latest upload revision, in normal output, dry runs and JSON. Run `quaso translate`
or review those keys on the website. Set `"outdated": "omit"` to leave their entries out while
preserving current translations, literals and references; affected arrays are omitted whole.
Historical `--at` downloads preserve the original bytes and refuse either omission option.

A document (a Markdown file) with nothing to write, because it is untranslated with
`"untranslated": "omit"` or outdated with `"outdated": "omit"`, is deleted from the repository
instead of being written empty, and listed as deleted, so the app falls back to its source
language. Local edits to a document are protected unless you pass `--overwrite-local`.

| Option              | Meaning                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--overwrite-local` | Replace local changes. Review or import them first.                                                                                                                                                   |
| `--dry-run`         | List what would be written, deleted, or kept because of local edits, without changing anything.                                                                                                       |
| `--at <UTC time>`   | Download the published versions current at this time, such as `2026-09-01T00:00Z`.                                                                                                                    |
| `--language <lang>` | Only these languages. Repeatable, or a comma list. Default: the config's `languages`.                                                                                                                 |
| `--file <path>`     | Only this file: its path on the instance or its source file's local path (in every language), or a translation file's local path (in that language only). Repeatable.                                 |
| `--prune`           | Also delete translation files whose source file no longer exists: only files the `translation` pattern could have written, for a path the `source` glob could match. Can't be combined with `--file`. |

The CLI computes every path itself and checks all of them before it writes the first file (see
[Safety](#safety)). `quaso download --file src/locales/pl/common.json` downloads that one file;
naming a translation file of another language than `--language` is an error.

`--at` reads stored published bytes, so later translation edits do not change the result.
The instance publishes after five seconds without writes that change the downloaded content, capped at one minute.
Only versions still in history are available; a missing version object returns `410 expired`.
Local path checks and the config's language and file selection still apply.

Downloads keep the last written values in `.quaso/download-state`, scoped to the instance and
local file. When a download would change a locally changed value, it lists `local edit`, keeps the
whole file and returns exit code 6. Other files can still download. `--dry-run` lists conflicts
without changing files or the saved comparison values; a dry run returns exit code 0 even when it lists local edits. Import local fixes with `quaso import --as blue`, or use
`--overwrite-local` after reviewing them. On the first download, existing values that match
neither the incoming values nor source values are treated as local edits. Keep `.quaso/`
ignored by Git; it contains local state.

`--prune` does not check local edits in files whose source no longer exists. Review its dry-run
list before allowing those deletions.

### `quaso translate`

Asks the instance's large language model (LLM) to translate the untranslated strings of the config's languages (or
`--language`), in every file (or `--file`), and waits for it. Outdated translations are updated too;
proofread (blue) translations never change: an outdated one gets a proposal that a manager reviews.
If **Reuse translations of identical source strings** is enabled, a job can copy a current
matching translation as green before asking the model. This setting is off by default.
Every result goes through the quality checks. Results that keep failing are not saved; any
previously accepted translation remains.

This command updates outdated translations regardless of the automatic translation settings used
for uploads.

```text
Starting the translation of de, fr, pl on https://translate.yourgame.com…
Translation job 12 is queued (84 strings).
Translating: 50 of 84 (59%).
Translation job 12 done: 83 translated, 1 failed (48,210 tokens).

Strings that stayed untranslated (1):
  src/locales/pl/store.json › title (pl): at most 30 characters; this has 34
```

| Option                 | Meaning                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--language <lang>`    | Only these languages. Repeatable, or a comma list. Default: the config's `languages`.                                  |
| `--file <path>`        | Only this file: its path on the instance (`common.json`) or its source file's local path. Repeatable.                  |
| `--retranslate`        | Also translate green (translated, not proofread) strings again. Blue (proofread) strings never change.                 |
| `--qa`                 | Also translate again the green strings that fail the quality checks, such as values imported with `--allow-qa-errors`. |
| `--instruction <text>` | An instruction for this run, such as `"Address the player informally"`. It is added to the prompt for this run.        |
| `--model <name>`       | The model for this run, instead of the instance's, such as `gemini-2.5-pro`.                                           |
| `--no-wait`            | Start the job and exit. The instance runs it; `quaso status` shows the result.                                         |
| `--dry-run`            | Count the strings and words, and estimate the requests and tokens, without translating anything (see below).           |

By default, the command checks job progress every two seconds and prints it to stderr. It exits
with code 6 if strings failed or the job failed, was cancelled, or paused. Failures use
`file › key (lang): reason`, with the local translation path. A job paused for a spent monthly
token budget or a rejected Gemini key can resume after the issue is resolved.

`--dry-run` prints what a run would do:

```text
Dry run: nothing was translated.
  de  28 strings   96 words
  pl  56 strings  192 words

84 strings (288 words) in 4 requests: about 18,400 input and 2,900 output tokens.
Of these: 78 untranslated, 4 outdated green to update, 2 outdated proofread to get a proposal for review.
```

The estimate counts characters / 4 of each request's prompt and the expected answer; thinking models
use more, and retries add some. An instance without an LLM (no Gemini key in its Settings) answers with exit
code 4 and says so. An API key needs the `upload` scope and a creator who can translate the selected languages.

### `quaso status`

Shows progress per language:

```text
40 strings, 139 words (source language: en)

Language                    Untranslated  Green  Blue  Outdated  Pending  QA  Translated • Proofread
de     German                          0      0    40         0        0   0  100% • 100%
fr     French                         26     14     0         0        0   0  33% • 0%
ja     Japanese                       40      0     0         0        0   0  0% • 0%
```

Green translations are translated but not proofread; blue ones are proofread; outdated ones were
made for older source text; pending strings have suggestions waiting for review; QA counts quality
errors and stored warnings, such as meaning or consistency issues. The percentages count source words.
See [Translation concepts](concepts.md) for how states overlap. Quality assurance (QA) checks cover issues such as missing
placeholders and excess length; they do not prove that a translation has the right meaning.

| Option              | Meaning                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--language <lang>` | Only these languages. Repeatable, or a comma list.                                                                                                                        |
| `--fail-on <state>` | Exit with code 7 when a string of the config's languages (or of `--language`) is `untranslated`, `outdated`, or `green` (not yet proofread). Repeatable, or a comma list. |

`--fail-on` does not check pending suggestions or QA errors. Review those counts separately before
a release.

Languages present on the instance but absent from the config are shown with a `*`. By default,
`--fail-on` checks only the config's languages. When you pass `--language`, it checks the named
languages instead, including languages outside the config. A language missing from both the config
and instance is an error (exit code 2).

A selected language that exists only in the config produces a warning and counts as untranslated,
using the source string count from the instance's other languages. If the instance has no target
languages, that count is zero. Run `upload` before using status as a release check.

### `quaso import`

Imports translation files you already have, such as those from Crowdin, from where the config's
`translation` pattern points. Upload the source files first. Keys absent from the source are skipped and listed.
A Markdown translation file is imported whole; a blank one is skipped.

| Option              | Meaning                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--as <colour>`     | `green` (translated, not proofread) or `blue` (proofread). Required.                                                                             |
| `--from <folder>`   | Read translation patterns under this existing folder instead of the project. Files are only read.                                                |
| `--language <lang>` | Only these languages. Repeatable, or a comma list. Default: the config's `languages`.                                                            |
| `--file <path>`     | Only this file: its path on the instance or a local source path (in every language), or a local translation path (in its language). Repeatable.  |
| `--overwrite`       | Also replace blue (proofread) translations on the instance. Without it, they stay.                                                               |
| `--keep-identical`  | Keep values identical to the source. Without it, they are skipped because exports can use source text for untranslated entries.                  |
| `--allow-qa-errors` | Import values that fail the quality checks, with their QA errors, instead of refusing them. They are listed, and the instance counts them in QA. |
| `--dry-run`         | Show what would be imported without saving anything.                                                                                             |

To preserve Crowdin's proofread state, import its approved-only export first with
`quaso import --as blue --from /tmp/crowdin-approved`, then import the full export with
`quaso import --as green`. With `src/locales/{lang}/{path}` in the config, `--from` reads
`/tmp/crowdin-approved/src/locales/{lang}/{path}`. Relative folders are resolved from the
current directory. The export needs no config or source files; the project supplies those.
Blue translations stay, and values identical to the source are skipped in both runs. Empty values
are always skipped, including with `--keep-identical`.

Unused plural forms are dropped and counted in the summary. For example, Japanese uses `other`,
so an import of `coins_one` and `coins_other` keeps only `coins_other`. Values that fail the quality
checks are listed and refused; valid values still import, and the command exits with code 6.
With `--allow-qa-errors`, those values import too and appear under **Imported with QA errors**.
QA errors alone then do not cause exit code 6. A refusal looks like this:

```text
Refused by the quality checks (1):
  src/locales/fr/common.json › level (fr): placeholder {{total}} is missing
```

The instance imports one language at a time. Before the first, the CLI checks that the instance has
every language it is about to import, and imports nothing when one is missing (exit code 2;
`quaso upload` adds the config's languages). If a language fails after others were imported, the
others stay imported: the output lists the failed languages (`result.failed` with `--json`) and the
exit code is 6, so import them again with `--language`.

### `quaso version` and `quaso help`

`quaso version` (or `--version`) prints the version and the runtime. `quaso help`, `quaso --help`,
`quaso help <command>` and `quaso <command> --help` print the help, with each command's options and
exit codes. With `--json`, the help is data: every command, its options and the exit codes.

## Options for every command

| Option            | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `--json`          | Print one JSON document on stdout (see below).                                                     |
| `--cwd <dir>`     | Run as if started in this folder.                                                                  |
| `--config <path>` | Use this config file instead of the nearest `quaso.config.json`. Its folder is the project folder. |
| `-h`, `--help`    | Show the help.                                                                                     |
| `--version`       | Print the version.                                                                                 |

Results go to stdout; progress, warnings and errors go to stderr. Colours are used only in a
terminal, never when `NO_COLOR` is set (to any value), and never with `--json`.

## JSON output

With `--json`, the CLI writes one JSON document to stdout for a result or a handled error:

```json
{
  "schemaVersion": 1,
  "command": "status",
  "ok": false,
  "exitCode": 7,
  "result": {
    "server": "https://translate.yourgame.com",
    "revision": 12,
    "sourceLanguage": "en",
    "languages": [
      { "tag": "ja", "name": "Japanese", "strings": 40, "untranslated": 40, "inConfig": true }
    ],
    "missing": [],
    "failOn": {
      "states": ["untranslated"],
      "met": true,
      "hits": [{ "language": "ja", "state": "untranslated", "count": 40 }]
    }
  }
}
```

This example omits some language counts and per-file results.

- `schemaVersion` changes only when the documents change in a way that could break a script.
- `ok` is true when `exitCode` is 0.
- `result` is the command's result: for `upload`, the instance's answer with each file's
  `localPath`, each rename suggestion's `command`, and `renameCommand`, which applies them all; for
  `download`, the files `written`, `unchanged`, `pruned` and `skipped`; for `translate`, the
  `estimate` of a dry run, or the `job` (its status, progress, tokens and failures) and the
  `failures` with local paths, and whether the command `waited` (`upload --wait` puts the same `job`
  and `failures` in `wait`); for `status`, every language's counts (and each file's) and `failOn`;
  for `import`, each language's counts, and the `refused` values, `unknownKeys` and `invalid` files
  with their local paths, and the `failed` languages.
- When an error stops the command, `error` replaces `result`. A completed command can still return
  `result` with a nonzero `exitCode`, such as an import with refused values or a status condition.
  An error has this shape: `{ "code": "missing_key", "message": "…", "hint": "…", "details": [ … ] }`. `code` is the
  instance's error code (such as `invalid_source`, `unauthorized`, `validation_failed`) or one of
  the CLI's own, such as `usage`, `invalid_config`, `config_not_found`, `missing_key`,
  `invalid_key`, `missing_hostname`, `network`, `timeout`, `unsafe_path`, `unknown_file`,
  `unknown_language`, `redirect`, `bad_response`. Each detail names what applies of `file` (a local
  path), `key`, `language`, `line`, `column` and `check`.

Download results also include `outdated`, `localEdits`, and `removed` (documents removed by an
omission setting). Upload results include `localTranslations` and `imports`. Read these fields
even when a command returns a result with a nonzero exit code.

## Exit codes

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | success                                                                               |
| 1    | unexpected error                                                                      |
| 2    | bad usage or invalid config                                                           |
| 3    | authentication or permission problem (missing API key, wrong scope)                   |
| 4    | network error or server unavailable; check before repeating a write                   |
| 5    | invalid source file (JSON syntax, duplicate key)                                      |
| 6    | some items failed, were refused, or were kept because of local edits; read the output |
| 7    | the `status --fail-on` condition is met                                               |

Read requests and previews are retried up to three times after network errors, timeouts, and
HTTP 429, 502, 503, or 504 responses. The delay increases between attempts, includes a random
variation, and respects `Retry-After` values of up to 60 seconds. Uploads and imports are retried only when retrying is safe.
Requests time out after 30 seconds (5 minutes for uploads, downloads and imports).

What the instance doesn't have (a file not uploaded yet, a language), a request larger than it
accepts, and an address that isn't a Quaso instance are exit code 2: fix the command, the config or
`QUASO_HOSTNAME`. An answer to `download` with a language or a file that wasn't asked for is refused
with exit code 4, and nothing is written.

## Running in CI

Upload source files when they change on the main branch. Check translation status before a release.
The CLI does not run Git. Your workflow creates a pull request for downloaded files.
The example assumes English sources in `src/locales/en/`, a committed CLI dependency and lockfile,
and an upload key created by an administrator, stored as the `QUASO_API_KEY` repository secret.
Replace the hostname. This workflow treats target files as generated: `--overwrite-local` lets a
fresh checkout replace them and submit the changes for review. Import any edits made directly
in those files before running it; a fresh runner has no previous download state.

```yaml
name: Translations
on:
  push:
    branches: [main, master]
    paths: ["src/locales/en/**", "quaso.config.json"]
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

env:
  QUASO_HOSTNAME: translate.yourgame.com
  QUASO_API_KEY: ${{ secrets.QUASO_API_KEY }}

jobs:
  translations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx quaso upload
      - run: npx quaso download --overwrite-local
      - uses: peter-evans/create-pull-request@v7
        with:
          branch: translations
          title: Update translations
          commit-message: Update translations
```

In a release pipeline, hold the release back until every string is translated:

```sh
npx quaso status --fail-on untranslated
```

Enable **Allow GitHub Actions to create and approve pull requests** in the repository settings.
See [CI setup](add-to-your-game.md#ci) for separate upload and release workflows.

To translate in CI as well, add `npx quaso translate` after the upload (or `npx quaso upload --wait`
when the instance translates new strings automatically), before the download. Exit code 6 then means
that some strings or the job failed: the output lists the result.

Exit code 4 means a network or server failure. Reads and previews can be repeated. If a write
timed out or its response was lost, check the instance before repeating it: the write might have
finished. This matters for renames and translation jobs, which can change the result or spend tokens.
Exit code 3 usually means the secret is missing, the key lacks the required scope or creator permissions, or the secret has
a stray character such as a quote or a line break (the CLI never prints the key). The exit code
stays the command's when a pipe closes early, as in `quaso status 2>&1 | head -1`.

## For AI agents

- Pass `--json` and read one JSON document from stdout; progress and errors go to stderr.
- `quaso help --json` describes every command, option and exit code.
- Commands do not prompt for input. Missing options produce errors (exit code 2) that say what to add.
- Try changes with `--dry-run` first: `upload`, `download`, `translate` and `import` take it.
  `quaso translate --dry-run --json` gives the strings, words, requests and estimated tokens before starting a job.
- Errors name the file (local path), key and language, and JSON error details identify the same items:
  `src/locales/pl/common.json › inventory.itemCount (pl): placeholder {{total}} is missing`.
- After `upload`, `result.renameSuggestions[].command` is the exact command to apply each rename,
  and `result.renameCommand` applies them all. Check the suggestions first: the same source text under a
  new key is usually, but not always, a rename.

## Safety

- The CLI computes every output path itself from the config and the languages it asked for. A path
  from the instance is only used to find the local source file it belongs to; an answer with a
  language or a file that wasn't asked for is refused.
- It refuses to write a source file, the config file, the source language, a file a `source` glob
  would find, or anything outside the project folder, and it checks every path before it writes
  the first file. `--prune` only deletes files the `translation` pattern could have written for a
  source file that no longer exists.
- Upload reads files inside the project folder. Import reads there by default, or inside the
  folder selected with `--from`.
- Symbolic links aren't followed. A file to read, write or delete with a link anywhere on its path
  inside the project, the file itself or one of its folders, is refused with `unsafe_path` (exit
  code 2), even when the link stays inside the project: a committed link could otherwise upload an
  ignored file such as `.env`, or have a download write into `.git`. Replace the link with a
  regular file or folder. A link to the project folder itself is fine.
- Files are written through a temporary file and a rename, so none is ever half-written.
- It never starts other programs and never runs git. The build fails if the bundle could start a
  process.
- Tests run every command against a real server and check that the source files are byte for byte
  the same afterwards.
