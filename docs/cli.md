# The CLI

`quaso` is the command line of Quaso. It sends your game's English (source) files to your Quaso
instance, asks the instance's LLM to translate them, writes the translations back into your
repository, shows progress, holds a release back when translations are missing, and imports
translations you already have. It works the same on a laptop, in CI and for AI agents: it never asks
anything, it can print JSON, and its exit codes say what happened.

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

The CLI runs on Node 22 or later and on Deno 2.9 or later. It is one JavaScript file with no
dependencies.

**With npm**, pin it in your game's `package.json`, so that everyone and CI use the same version:

```sh
npm install --save-dev @quaso-i18n/cli
npx quaso status
```

Or run a version without installing it: `npx @quaso-i18n/cli@1.0.0-rc.1 status`.

**With Deno**, run it from npm:

```sh
deno run -A npm:@quaso-i18n/cli@1.0.0-rc.1 status
```

To install a global `quaso` command, run `deno install --global -A --name quaso npm:@quaso-i18n/cli`.

## Connecting to your instance

Two environment variables connect the CLI to your team's Quaso instance:

| Variable         | What it is                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `QUASO_HOSTNAME` | The instance, such as `translate.yourgame.com`. HTTPS is assumed; a full URL such as `http://localhost:8000` also works, for development. |
| `QUASO_API_KEY`  | An API key of the instance. A key with the `read` scope can `download` and see `status`; `upload` and `import` need the `upload` scope.   |

```sh
export QUASO_HOSTNAME=translate.yourgame.com
export QUASO_API_KEY=qso_…
```

Administrators create API keys on the instance. The key only ever comes from the environment: the
CLI refuses a config file that contains one. A team that prefers to commit the hostname can put
`"hostname"` in the config file instead; `QUASO_HOSTNAME` wins over it.

The CLI never follows redirects, so your key only goes where `QUASO_HOSTNAME` points. If the
instance redirects (for example from `http://` to `https://`), the error says which address to use.

## The config file

The CLI reads `quaso.config.json` from the current folder, or from the nearest parent folder that
has one. That folder is the project folder: every path in the config is relative to it, and the CLI
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

| Field                 | Meaning                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`             | The JSON Schema of the file, which your instance publishes at `/schema/config-v1.json`, for completion and checks in editors. Optional.                                                                                                                          |
| `hostname`            | The instance, when `QUASO_HOSTNAME` isn't set. Optional.                                                                                                                                                                                                         |
| `sourceLanguage`      | The language of your source files, as a BCP 47 tag such as `en`.                                                                                                                                                                                                 |
| `languages`           | The languages to translate into: what `download` writes and `status --fail-on` counts. `upload` adds any of them that the instance lacks. Languages that the instance has and the config doesn't list, such as one volunteers are just starting, are left alone. |
| `languageMapping`     | The name a language has in your game, when it differs from its tag: `{ "zh-Hans": "zh-CN" }` writes Simplified Chinese to `src/locales/zh-CN/`. Optional.                                                                                                        |
| `files`               | Where the files are: one or more entries, each with `source`, `translation` and an optional `exclude`.                                                                                                                                                           |
| `files[].source`      | A glob of the source files, such as `src/locales/en/**/*.json`.                                                                                                                                                                                                  |
| `files[].translation` | Where translations go, with `{lang}` (the language as your game names it, after `languageMapping`) and `{path}` (the source file's path below the folder where the glob starts).                                                                                 |
| `files[].exclude`     | Globs of source files to leave out, relative to the project folder. Optional.                                                                                                                                                                                    |
| `limits`              | Maximum lengths, such as for app store fields, in user-perceived characters. `file` is the file's path as the instance knows it (below the folder where the glob starts). They win over limits set on the website. Optional.                                     |
| `pluralExclusions`    | Groups of keys that only look like plurals (`menu.power_one`, `menu.power_other`), named without the category. Optional.                                                                                                                                         |

**Globs** use `/` on every system: `*` matches within a folder, `**` matches any number of folders,
`?` one character, `{a,b}` either alternative, and `[abc]`, `[a-z]` or `[!abc]` one character of a
set. Folders named `node_modules` or starting with a dot are skipped.

**Paths on the instance.** Each source file is known to the instance by its path below the folder
where its glob starts: with `src/locales/en/**/*.json`, the file `src/locales/en/menus/main.json` is
`menus/main.json`, and its German translation goes to `src/locales/de/menus/main.json`. Two source
files can't have the same path on the instance. A single file works too:
`"source": "locales/en.json"` with `"translation": "locales/{lang}.json"`.

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
`preserve_hierarchy: true`. These semantics follow [Crowdin's path and mapping rules](https://crowdin.github.io/crowdin-cli/advanced).
Layouts that would flatten recursive source paths and unsupported placeholders are reported
and skipped. Conversion fails without writing when no file entries can be converted.

Existing translation files supply target languages; an existing `zh` folder proposes
`zh-Hans` and prints a reminder to check it. Override inferred languages with `--languages`
and folder names with `--language-mapping`. Named-language folders need an explicit mapping.
Crowdin's `base_path` must be `.`; run from the project root. The original YAML is only read,
and its credentials are never copied into the config or printed in YAML errors.

### `quaso upload`

Sends every source file to the instance, unchanged, with the config's languages, limits and plural
exclusions, and prints what was added, changed and removed. The instance parses the files, so a fix
in how files are read never needs a new CLI.

Each upload includes two paths: the identity below the source glob's base (`menu.json`) and
its display path relative to `quaso.config.json` (`src/locales/en/menu.json`). Moving that display
path preserves translations and history. Download and import still use the identity path.

| Option               | Meaning                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`          | Compute and show the changes without saving them.                                                                                                                                                                                                                                        |
| `--file <path>`      | Upload only this file: its path on the instance (`common.json`) or its local path. Repeatable. The other files stay as they are. Without `--file`, files missing from the upload are hidden on the instance (never deleted; they come back with their translations when uploaded again). |
| `--rename <old=new>` | Move a key's translations and history to its new name: `old=new`, or `file:old=new` when the key isn't unique. A key with `=` in it is written as a JSON string: `"x = y"=equation`. Repeatable.                                                                                         |
| `--wait`             | Wait for the automatic translation job the upload queues, if any, as [`quaso translate`](#quaso-translate) does: progress on stderr, then the strings that failed, with exit code 6.                                                                                                     |

When a removed key and an added key have the same English, the output suggests a rename and prints
the exact command, quoted for the shell:

```text
Possible renames (a removed key and an added key with the same English):
  src/locales/en/common.json › saved → gameSaved
    quaso upload --rename common.json:saved=gameSaved
```

Uploading the same files twice changes nothing. A file that isn't valid JSON, or has a duplicate
key, stops the upload with exit code 5 and its place:
`src/locales/en/menus.json:3:19: trailing comma is not allowed`.

When the instance translates automatically (a setting, on by default, when it has an LLM), the
upload queues a translation job for the added and changed strings, and says so. It also updates
outdated translations that aren't proofread, and proposes updates for proofread ones. With `--wait`,
the command waits for that job.

### `quaso download`

Writes every language's files where the config's `translation` pattern says. Strings that aren't
translated yet are written in the source language, so the game always has every key. Files whose
content hasn't changed are left alone: a second download writes nothing.

| Option              | Meaning                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`         | List what would be written or deleted, without changing anything.                                                                                                                                     |
| `--at <UTC time>`   | Download the published versions current at this time, such as `2026-09-01T00:00Z`.                                                                                                                    |
| `--language <lang>` | Only these languages. Repeatable, or a comma list. Default: the config's `languages`.                                                                                                                 |
| `--file <path>`     | Only this file: its path on the instance or its source file's local path (in every language), or a translation file's local path (in that language only). Repeatable.                                 |
| `--prune`           | Also delete translation files whose source file no longer exists: only files the `translation` pattern could have written, for a path the `source` glob could match. Can't be combined with `--file`. |

The CLI computes every path itself and checks all of them before it writes the first file (see
[Safety](#safety)). `quaso download --file src/locales/pl/common.json` downloads that one file;
naming a translation file of another language than `--language` is an error.

`--at` reads stored published bytes, so later translation edits do not change the result.
The instance publishes after five seconds without download-changing writes, capped at one minute.
Only versions still in history are available; a missing version object returns `410 expired`.
Local path checks and the config's language and file selection still apply.

### `quaso translate`

Asks the instance's LLM to translate the untranslated strings of the config's languages (or
`--language`), in every file (or `--file`), and waits for it. Outdated translations are updated too;
proofread (blue) translations never change: an outdated one gets a proposal that a manager reviews.
Every result goes through the quality checks, like a person's translation, and a string whose result
keeps failing them stays untranslated.

```text
Starting the translation of de, fr, pl on https://translate.yourgame.com…
Translation job 12 is queued (84 strings).
Translating: 50 of 84 (59%).
Translation job 12 done: 83 translated, 1 failed (48,210 tokens).

Strings that stayed untranslated (1):
  src/locales/pl/store.json › title (pl): at most 30 characters; this has 34
```

| Option                 | Meaning                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--language <lang>`    | Only these languages. Repeatable, or a comma list. Default: the config's `languages`.                                   |
| `--file <path>`        | Only this file: its path on the instance (`common.json`) or its source file's local path. Repeatable.                   |
| `--retranslate`        | Also translate green (translated, not proofread) strings again. Blue (proofread) strings never change.                  |
| `--instruction <text>` | An instruction for this run, such as `"Address the player informally"`. It comes after the instance's own instructions. |
| `--model <name>`       | The model for this run, instead of the instance's, such as `gemini-2.5-pro`.                                            |
| `--no-wait`            | Start the job and exit. The instance runs it; `quaso status` shows the result.                                          |
| `--dry-run`            | Count the strings and words, and estimate the requests and tokens, without translating anything (see below).            |

By default the command waits for the job, asking the instance for its progress every 2 seconds, and
prints the progress on stderr. It exits with code 6 when strings failed, listing each one as
`file › key (lang): reason`, with the local path of the translation file; also when the job failed,
was cancelled, or paused (because the instance's monthly token budget is used up, or its Gemini key
was refused: the job goes on by itself once that is fixed).

`--dry-run` prints what a run would do:

```text
Dry run: nothing was translated.
  de  28 strings   96 words
  pl  56 strings  192 words

84 strings (288 words) in 4 requests: about 18,400 input and 2,900 output tokens.
```

The estimate counts characters / 4 of each request's prompt and the expected answer; thinking models
use more, and retries add some. An instance without an LLM (no `GEMINI_API_KEY`) answers with exit
code 4 and says so; an API key needs the `upload` scope.

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
made for older English; pending strings have suggestions waiting for review; QA counts translations
that fail the quality checks. The percentages count words.

| Option              | Meaning                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--language <lang>` | Only these languages. Repeatable, or a comma list.                                                                                                                        |
| `--fail-on <state>` | Exit with code 7 when a string of the config's languages (or of `--language`) is `untranslated`, `outdated`, or `green` (not yet proofread). Repeatable, or a comma list. |

Languages the instance has but the config doesn't list are shown with a `*`, and `--fail-on` leaves
them out. A language of the config that the instance doesn't have yet (`quaso upload` adds it)
counts as untranslated, with a warning, whether or not `--language` names it. A language that
neither has is an error (exit code 2).

### `quaso import`

Imports translation files you already have, such as those from Crowdin, from where the config's
`translation` pattern points. Upload the English first: keys the English doesn't have are skipped
and listed.

| Option              | Meaning                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--as <colour>`     | `green` (translated, not proofread) or `blue` (proofread). Required.                                                                            |
| `--from <folder>`   | Read translation patterns under this existing folder instead of the project. Files are only read.                                               |
| `--language <lang>` | Only these languages. Repeatable, or a comma list. Default: the config's `languages`.                                                           |
| `--file <path>`     | Only this file: its path on the instance or a local source path (in every language), or a local translation path (in its language). Repeatable. |
| `--overwrite`       | Also replace blue (proofread) translations on the instance. Without it, they stay.                                                              |
| `--keep-identical`  | Keep values identical to the English. Without it, they are skipped, because tools such as Crowdin write the English into untranslated entries.  |
| `--dry-run`         | Show what would be imported without saving anything.                                                                                            |

To preserve Crowdin's proofread state, import its approved-only export first with
`quaso import --as blue --from /tmp/crowdin-approved`, then import the full export with
`quaso import --as green`. With `src/locales/{lang}/{path}` in the config, `--from` reads
`/tmp/crowdin-approved/src/locales/{lang}/{path}`. Relative folders are resolved from the
current directory. The export needs no config or English files; the project supplies those.
Blue translations stay, and values identical to English are skipped in both runs.

Plural forms a language doesn't use are ignored rather than refused: files that repeat the English
categories, such as `coins_one` beside `coins_other` in Japanese, import their `other` form, and the
summary counts the unused forms dropped. Values that fail the quality checks are refused and listed,
and the exit code is 6; the other values are imported:

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

With `--json`, stdout gets exactly one JSON document, whatever happens:

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

(The language is shortened here: it has every count, and each file's.)

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
- When the command fails, `error` replaces `result`:
  `{ "code": "missing_key", "message": "…", "hint": "…", "details": [ … ] }`. `code` is the
  instance's error code (such as `invalid_source`, `unauthorized`, `validation_failed`) or one of
  the CLI's own, such as `usage`, `invalid_config`, `config_not_found`, `missing_key`,
  `invalid_key`, `missing_hostname`, `network`, `timeout`, `unsafe_path`, `unknown_file`,
  `unknown_language`, `redirect`, `bad_response`. Each detail names what applies of `file` (a local
  path), `key`, `language`, `line`, `column` and `check`.

## Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | success                                                                |
| 1    | unexpected error                                                       |
| 2    | bad usage or invalid config                                            |
| 3    | authentication or permission problem (missing API key, wrong scope)    |
| 4    | network error or server unavailable (safe to retry)                    |
| 5    | invalid source file (JSON syntax, duplicate key)                       |
| 6    | finished, but some items were refused or failed; the output lists them |
| 7    | the `status --fail-on` condition is met                                |

Requests that change nothing are retried after network errors (including an answer that breaks off),
timeouts, and when the instance is busy (429, 502, 503, 504), up to three times with increasing,
jittered waits, honouring `Retry-After`. Uploads and imports are retried only when retrying is safe.
Requests time out after 30 seconds (5 minutes for uploads, downloads and imports).

What the instance doesn't have (a file not uploaded yet, a language), a request larger than it
accepts, and an address that isn't a Quaso instance are exit code 2: fix the command, the config or
`QUASO_HOSTNAME`. An answer to `download` with a language or a file that wasn't asked for is refused
with exit code 4, and nothing is written.

## Running in CI

Upload the English on every push to the main branch, and check that a release is fully translated.
The CLI never runs git: to commit the downloaded files, your workflow does.

```yaml
name: Translations
on:
  push:
    branches: [main, master]
    paths: ["src/locales/en/**"]
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
      - run: npx quaso download
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

To translate in CI as well, add `npx quaso translate` after the upload (or `npx quaso upload --wait`
when the instance translates new strings automatically), before the download. Exit code 6 then means
that some strings stayed untranslated: the output lists them.

Exit code 4 means the instance couldn't be reached or was busy: it is safe to run the step again.
Exit code 3 usually means the secret is missing, the key lacks the `upload` scope, or the secret has
a stray character such as a quote or a line break (the CLI never prints the key). The exit code
stays the command's when a pipe closes early, as in `quaso status 2>&1 | head -1`.

## For AI agents

- Pass `--json` and read one JSON document from stdout; progress and errors go to stderr.
- `quaso help --json` describes every command, option and exit code.
- Nothing is ever asked: missing options are errors (exit code 2) that say what to add.
- Try changes with `--dry-run` first: `upload`, `download`, `translate` and `import` take it.
  `quaso translate --dry-run --json` gives the strings, words, requests and tokens a run would take,
  before it spends any.
- Errors name the file (local path), key and language, in the same format as in the JSON details:
  `src/locales/pl/common.json › inventory.itemCount (pl): placeholder {{total}} is missing`.
- After `upload`, `result.renameSuggestions[].command` is the exact command to apply each rename,
  and `result.renameCommand` applies them all. Check the suggestions first: the same English under a
  new key is usually, but not always, a rename.

## Safety

- The CLI computes every output path itself from the config and the languages it asked for. A path
  from the instance is only used to find the local source file it belongs to; an answer with a
  language or a file that wasn't asked for is refused.
- It refuses to write a source file, the config file, the source language, a file a `source` glob
  would find, or anything outside the project folder, including through a symbolic link, and it
  checks every path before it writes the first file. `--prune` only deletes files the `translation`
  pattern could have written for a source file that no longer exists.
- It only sends files that are inside the project folder: `upload` and `import` refuse a symbolic
  link that leads outside it.
- Files are written through a temporary file and a rename, so none is ever half-written.
- It never starts other programs and never runs git. The build fails if the bundle could start a
  process.
- Tests run every command against a real server and check that the English files are byte for byte
  the same afterwards.
