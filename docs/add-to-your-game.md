# Add Quaso to your game

Connect your game repository to Quaso, choose where translations go, and add checks before a
release. Quaso supports [i18next and ICU MessageFormat in JSON files and Markdown documents](file-formats.md). The downloaded files become ordinary
game assets; the game needs no connection to Quaso at runtime.

## Before you start

You need a Quaso instance, an API key with the `upload` scope, and Node 22 or later with npm.
Create the key while signed in as an administrator, in **Account → API keys**.
A key follows its creator's current role; an upload scope alone does not grant file access. To host an instance, follow
[Deploy with Docker](deploy-docker.md) or [Deploy on Cloudflare](deploy-cloudflare.md).

These instructions describe current `main`. The examples install the `main` CLI package; for a
tagged release, use the CLI and documentation from that release. Keep the package version matched
to your instance.

The examples use English source files in `src/locales/en/` and German, French, and Polish as target
languages. Replace the example hostname, key, paths, and language tags with your own values. For
an existing Crowdin project, use [Migrate from Crowdin](migrate-from-crowdin.md) instead.

## Choose the message format

Before the first upload, open **Settings → Placeholders** as an administrator. Leave
**ICU MessageFormat** off for i18next JSON v4 (`{{name}}` and separate plural keys). Turn it on
for ICU MessageFormat (`{name}` and plural or select blocks inside strings), including i18next-icu.
The setting applies to all JSON strings and Markdown documents in the project.

The CLI commands and file mappings below work for both. See the
[comparison and source examples](file-formats.md#choose-your-message-format) for the differences.

## Connect and upload

1. In your game repository, install the command-line interface (CLI) and set the connection values:

   ```sh
   npm install --save-dev @quaso-i18n/cli@main
   export QUASO_HOSTNAME=translate.example.com
   export QUASO_API_KEY='your upload API key'
   ```

   These environment commands work in a POSIX shell, such as Bash or Zsh. For project tasks that
   load a `.env` file, follow [Connect the repository](workflow.md#1-connect-the-repository).
   Commit your package lockfile. Keep the API key out of version control.

2. Create the config:

   ```sh
   npx quaso init --languages de,fr,pl
   ```

   Check `quaso.config.json` before continuing. The default source language is `en` and the source
   pattern is `src/locales/en/**/*.json`. If your source language differs, pass `--source` to
   `init`. If a config already exists, edit it; `init` does not overwrite it.

3. Preview the upload, check the listed files, then upload:

   ```sh
   npx quaso upload --dry-run
   npx quaso upload
   ```

   Open **Sources** on the website and check the file paths and counts. Upload adds the target
   languages listed in the config. A full upload hides files missing from the upload, while
   retaining their translations and history. Use `upload --file` for a partial upload.

4. Translate on the website or start a job:

   ```sh
   npx quaso translate
   ```

   This command requires a Gemini key in **Settings → AI translation**. An upload can already
   start a job when automatic translation is enabled; use `upload --wait` to wait for that job.
   You can also translate by hand without a Gemini key. Follow [the translation workflow](workflow.md)
   to review a language and use it as a reference for later jobs.

5. Download, check the result, and test your game:

   ```sh
   npx quaso download --dry-run
   npx quaso download
   npx quaso status --fail-on untranslated
   git diff -- src/locales
   ```

   A missing translation downloads as source text by default. Download includes green, blue, and
   outdated accepted translations by default; it excludes pending suggestions. The status command exits with
   code 7 if any selected language has untranslated strings. Add `--fail-on outdated,green` if the
   release requires current, proofread text. These conditions do not check quality assurance (QA) errors; review the
   **QA** counts separately. See [Translation concepts](concepts.md) for the states and counts.

   If download reports a local edit, it keeps that file and exits with code 6. Import the edit or
   review it before using `download --overwrite-local`. Keep `.quaso/` in `.gitignore`; the CLI
   stores its previous downloads there to detect local changes.

## Configure paths and languages

Use `quaso.config.json` to define the source files and each language's output path:

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
  ]
}
```

In this config, `src/locales/en/ui/menu.json` becomes `src/locales/pl/ui/menu.json` for Polish.
`{path}` is the path below the fixed part of the source pattern. `{lang}` is the language tag,
replaced by `languageMapping` where set: Simplified Chinese uses the folder `zh-CN`, while its
language tag remains `zh-Hans`.

To translate Markdown documents, add another file rule, such as `"source": "text/en/**/*.md"`
with `"translation": "text/{lang}/{path}"`. Each file is translated as one text, of at most 6,000
words for the LLM. See [File formats](file-formats.md) for the document rules.

Keep source and translation folders separate. The CLI checks output paths before writing any
file and refuses writes outside the project or over source files. A second download writes only
files whose contents changed.

If a target language is maintained in your repository, set `translationsInRepository` to its
language tag. Every upload then imports its selected local files as proofread, replacing values
on the instance. Review import refusals before proceeding. For a one-time import that keeps
existing proofread values, use `upload --import-translations es:blue` instead.

See [the CLI config reference](cli.md#the-config-file) for all fields, patterns, and path rules.
See [File formats](file-formats.md) for placeholders, plural groups, ICU blocks, and length limits.

## CI

For continuous integration (CI), use separate workflows to upload source changes and prepare
translations for release. The [Quaso Quest example](../examples/demo-game/README.md) includes both:

- [Upload source strings](../examples/demo-game/.github/workflows/translations-upload.yml) runs
  when source files or the config change on `main` or `master`.
- [Prepare translations for release](../examples/demo-game/.github/workflows/translations-download.yml)
  runs manually or as a reusable workflow. It downloads, checks for untranslated strings, and
  opens a pull request. Merge that request and run your game tests before creating a release tag.

To use these workflows:

1. Set the repository variable `QUASO_HOSTNAME` to your instance hostname and the repository secret
   `QUASO_API_KEY` to an upload key. A download-only workflow can use a separate read key created by an administrator.
2. Copy the workflows and change `src/locales/fr/` to your source path. Adjust the branch name and
   output paths to match your repository. Commit the CLI dependency and lockfile so `npm ci` works.
3. Enable **Allow GitHub Actions to create and approve pull requests** in repository settings.
4. Run the download workflow manually and review its pull request before relying on it for releases.
   A fresh runner has no download state, so existing translations can count as local edits.
   The example stops when that happens. If your target files are generated and all local changes
   have been imported, use `download --overwrite-local` in your copy of the workflow; review its
   pull request before merging.

If the game lives below the repository root, also set `defaults.run.working-directory` for shell
steps. Trigger paths and the pull request's `add-paths` still need paths from the repository root.

Pull requests created or updated with `GITHUB_TOKEN` can start workflows that require a person
to approve the runs. For automatic runs without that approval step, use a suitable GitHub App
token or personal access token. Check [GitHub's workflow trigger guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
for the events and access rules that apply to your repository.

## Load the downloaded files

[Quaso Quest](../examples/demo-game/README.md) is a playable example with French sources and English
and German targets. Its [i18next setup](../examples/demo-game/src/i18n.js) loads language files and
falls back to French while translations are missing.

From a Quaso checkout, run:

```sh
cd examples/demo-game
npm install
npm run dev
```

Follow the example's README to start a local Quaso instance, upload its source files, and download
translations. Select English or German in the game to check the result.
