# @quaso-i18n/cli

The command line of Quaso, open-source localization for i18next JSON files. It uploads your source
files to your team's Quaso instance, writes the translations back into your repository, shows
progress, holds a release back when translations are missing, and imports the translations you
already have. It never asks anything, prints JSON with `--json`, and its exit codes say what
happened, so it works the same on a laptop, in CI and for AI agents.

It runs on Node 22 or later and Deno 2.9 or later: one file, no dependencies.

```sh
npm install --save-dev @quaso-i18n/cli    # then: npx quaso …
deno run -A npm:@quaso-i18n/cli status    # or with Deno, from npm
```

## Connecting

```sh
export QUASO_HOSTNAME=translate.yourgame.com   # https is assumed; http://localhost:8000 works too
export QUASO_API_KEY=qso_…                     # read scope: download, status; upload scope: upload, import
```

The API key only ever comes from the environment. `"hostname"` in the config file is a fallback for
`QUASO_HOSTNAME`.

## The config file

`quaso.config.json`, in the current folder or the nearest parent (`quaso init` writes one):

```json
{
  "sourceLanguage": "en",
  "languages": ["de", "fr", "pl", "ja", "zh-Hans"],
  "languageMapping": { "zh-Hans": "zh-CN" },
  "files": [{ "source": "src/locales/en/**/*.json", "translation": "src/locales/{lang}/{path}" }],
  "limits": [{ "file": "store.json", "key": "title", "maxLength": 30 }]
}
```

`{lang}` is the language as your game names it (after `languageMapping`); `{path}` is the source
file's path below the folder where the glob starts.

## Commands

| Command                       | Does                                                                          | Options                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `quaso init`                  | writes a starter `quaso.config.json`, and never overwrites one                | `--languages` (required), `--source`, `--files`, `--translation`                                    |
| `quaso upload`                | sends the source files and reports what was added, changed and removed        | `--dry-run`, `--file`, `--rename old=new`, `--wait`                                                 |
| `quaso download`              | writes every language's files, skipping files that haven't changed            | `--dry-run`, `--language`, `--file`, `--prune`                                                      |
| `quaso translate`             | asks the instance's LLM to translate untranslated strings, and waits for it   | `--language`, `--file`, `--retranslate`, `--instruction`, `--model`, `--no-wait`, `--dry-run`       |
| `quaso status`                | shows progress per language: untranslated, green, blue, outdated, pending, QA | `--language`, `--fail-on untranslated` (or `outdated`, `green`)                                     |
| `quaso import`                | imports existing translation files                                            | `--as green` or `--as blue`, `--language`, `--file`, `--overwrite`, `--keep-identical`, `--dry-run` |
| `quaso version`, `quaso help` | print the version, or the help of a command                                   |                                                                                                     |

Every command takes `--json` (one JSON document on stdout, with a `schemaVersion`), `--cwd <dir>`,
`--config <path>` and `--help`. Results go to stdout, progress and errors to stderr; colours only in
a terminal, and never with `NO_COLOR`.

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

## Safety

The CLI computes every output path itself from the config and the languages it asked for, and
refuses to write a source file, the source language, a file a `source` glob would find, or anything
outside the folder of `quaso.config.json`. It only sends files from inside that folder, never
through a symbolic link that leads out of it. It never starts other programs and never runs git.

The full guide, with every option, JSON output, CI and AI agents, is `docs/cli.md` in the Quaso
repository.
