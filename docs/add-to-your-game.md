# Add Quaso to your game

Quaso reads i18next JSON v4 files. Keep the source language in your repository and let Quaso write
the other languages. First [deploy an instance](deploy-docker.md) and create an upload API key in
Settings. The `quaso-cli` npm names must be reserved and published before these install
commands work. Before publication, run `deno task cli` from a Quaso checkout against its development
instance.

## Connect and upload

Install the CLI in your game repository (Node 22 or later):

```sh
npm i -D quaso-cli
export QUASO_HOSTNAME=translate.example.com
export QUASO_API_KEY='your upload API key'
npx quaso init --languages de,fr,pl
npx quaso upload
npx quaso translate
npx quaso download
npx quaso status --fail-on untranslated
```

With Deno 2.9, use `deno run -A npm:quaso-cli` in place of `npx quaso`, for example:

```sh
deno run -A npm:quaso-cli init --languages de,fr,pl
```

`init` writes `quaso.config.json` without prompting. Edit it before uploading if your files live
elsewhere. Commit the config and your package lockfile; keep the API key out of both. The hostname
may be in the config, but the environment overrides it. Source language defaults to `en`; use
`--source` for another language.

An upload queues automatic translation when the instance has a Gemini key and automatic translation
is enabled. `upload --wait` waits for that job. `translate` explicitly starts a run and waits for
it. People proofread on the website while development continues. A missing translation downloads as
the source text; `status --fail-on untranslated` exits 7 if any selected language still needs
translation. Add `--fail-on outdated` or `--fail-on green` when your release policy requires current
or proofread text.

## Configure paths and languages

```json
{
  "sourceLanguage": "en",
  "languages": ["de", "pl", "zh-Hans"],
  "languageMapping": { "zh-Hans": "zh-CN" },
  "files": [
    {
      "source": "src/locales/en/**/*.json",
      "translation": "src/locales/{lang}/{path}",
      "exclude": ["src/locales/en/private/**"]
    }
  ],
  "limits": [{ "file": "store.json", "key": "title", "maxLength": 30 }],
  "pluralExclusions": [{ "file": "menus.json", "key": "power" }]
}
```

- `sourceLanguage` and `languages` use BCP 47 tags. Upload adds missing target languages to the
  instance. The language list also defines which languages the release status gate checks.
- `source` is a glob relative to the config. `**/*.json` includes subfolders. `exclude` removes
  matching source paths. Keep source and translation folders separate.
- `{lang}` is the target language's folder name, after `languageMapping`. `{path}` is the source
  path below the glob's fixed directory: `src/locales/en/ui/menu.json` becomes
  `src/locales/pl/ui/menu.json`. A single source file can map to `locales/{lang}.json` instead.
- `languageMapping` changes filenames only, not language tags, plural rules or the API.
- `limits` measures user-perceived characters, including placeholders. Its `file` is the server path
  (`store.json`), not the local path. Config limits take precedence over website limits.
- `pluralExclusions` lists key groups that resemble plurals but are ordinary text. Use the group
  name without `_one` or `_other`; ordinal groups use `place_ordinal`. A literal dotted key can use
  a JSON array key path encoded as a string. For ambiguous limits use `#text`, `#plural` or
  `#ordinal`.

The CLI refuses paths outside the project, symlinks, and translation patterns that overlap source
globs. It validates all output paths before writing any file. It never changes source files or runs
git. Repeated downloads touch only files with changed bytes. See [the CLI reference](cli.md) for
file filtering, renames, imports, pruning, JSON output and exit codes.

## CI

Set repository variable `QUASO_HOSTNAME` to your instance and repository secret `QUASO_API_KEY` to a
named upload key. Use a separate read key if the download workflow lives in a separate environment.
Copy the workflows from [the demo game](../examples/demo-game/):

- `translations-upload.yml` uploads when source files or the config change on `main`.
- `translations-download.yml` runs manually or as a reusable workflow before your release. It
  downloads, requires no untranslated strings, and opens a pull request for review. Call it from
  your release preparation workflow with `secrets: inherit`. Merge its pull request before creating
  the release tag; it never changes an already published release.

The pull request keeps generated changes visible in code review and lets your usual tests run.
Enable GitHub Actions to create pull requests in repository settings. A repository that requires
checks triggered by that pull request may need its own GitHub App token: events from `GITHUB_TOKEN`
do not start most other Actions workflows. Keep that policy in your game's workflow, not in Quaso.

If source files are at the game repository root, keep the example workflows unchanged. When running
inside a monorepo, set `defaults.run.working-directory` and adjust the trigger and pull-request
paths. Commit your lockfile after installing the pinned CLI; the example uses `npm install` because
its release-candidate package is not published yet. A real game should use `npm ci` with its
lockfile.

## Load the downloaded files

The demo's [src/i18n.js](../examples/demo-game/src/i18n.js) loads JSON namespaces with i18next and
Node's built-in filesystem APIs. Run it without a build step:

```sh
cd examples/demo-game
npm install
node src/i18n.js pl
```

A browser game can load the same files with its existing asset pipeline. Quaso needs no runtime
connection from the game: translated JSON files are ordinary game assets.
