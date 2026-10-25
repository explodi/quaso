# Quick start

Connect a game to Quaso, upload its source text, and download translations for a build. This guide
uses English source files and German, French, and Japanese as target languages.

These guides describe the current source on `main`. The examples use its published builds. If you
run a tagged release, use the documentation from that tag; older releases can have different
settings. Refer to [CLI installation](cli.md#installing) for version choices.

You need a game with [supported JSON or Markdown files](file-formats.md), Node.js 22 or later on your
development computer, and a Quaso instance. The command examples use a POSIX shell, such as Bash
or Zsh. Replace the example hostname and key with your own values.

To try the workflow without a public server or a Gemini key, start
[Quaso Quest](../examples/demo-game/README.md). Its test translator demonstrates the workflow
without producing real translations.

## 1. Host your Quaso

Each instance holds one project. If you already have an instance and an administrator account,
continue to step 2. Otherwise, choose a hosting guide and complete its setup steps:

<!-- tabs -->

### Docker Compose

Use [Deploy with Docker Compose](deploy-docker.md) for a server you control. You need Docker
Engine, the Compose plugin, a domain name, and access to the server's network settings. The
deployment runs Quaso and Caddy, which serves the site over HTTPS.

### Cloudflare

Use [Deploy on Cloudflare](deploy-cloudflare.md) to create the Worker, Container, D1 database,
and R2 file storage. The guide covers account requirements, source and image versions, and the
setup command.

<!-- /tabs -->

At `https://translate.yourgame.com/setup`, enter the setup key, name the project, choose its source
language, and create the administrator account. Use the language of your game's source files;
this guide uses English. Keep the setup key out of Git.

Quaso's website is public. Visitors can read uploaded source text and translations without an
account. Upload only text intended for that audience.

Before uploading, choose the message format your game reads in **Settings → Placeholders**:

- **i18next JSON v4** (`{{name}}`, separate plural keys): leave **ICU MessageFormat** off.
- **ICU MessageFormat** (`{name}`, plural or select blocks inside strings): turn **ICU MessageFormat** on.
  This includes games using i18next-icu or another ICU MessageFormat library.

This setting applies to the whole project, including Markdown. It does not convert your strings:
to move an existing i18next project to ICU, see
[Move an i18next project to ICU MessageFormat](move-to-icu.md). See
[the comparison and examples](file-formats.md#choose-your-message-format) if you are unsure.

## 2. Connect your game and upload

While signed in as an administrator, open **Account → API keys** and create a key with the **upload** scope.
This key supports upload, translation, status, and download. Its permissions depend on your current
role as well as its scope. Copy the key when it appears; Quaso does not
show its full value again.

In your game's repository, install the command-line tool (CLI) and set the connection details:

```sh
npm install --save-dev @quaso-i18n/cli@main
export QUASO_HOSTNAME=translate.yourgame.com
export QUASO_API_KEY=qso_your_key
```

Create the configuration file:

```sh
npx quaso init --languages de,fr,ja
```

This command writes `quaso.config.json`. By default, it looks for English JSON files under
`src/locales/en/` and writes downloads under `src/locales/{lang}/`. If your files use another
language or location, pass `--source` and `--files` when running `init`. For example:

```sh
npx quaso init --source fr --languages en,de,ja --files 'public/locales/{source}/**/*.json'
```

Run one `init` command for your project. It does not replace an existing configuration file.
The configured source language must match the instance. Refer to
[Add Quaso to your game](add-to-your-game.md#configure-paths-and-languages) for other layouts.

Preview the upload, then send the files:

```sh
npx quaso upload --dry-run
npx quaso upload
```

Check the output for the expected files and languages, then open the website to confirm that the
source strings are present. Commit `quaso.config.json`, `package.json`, and the package lockfile.
Keep the API key out of Git. Upload reads your source files without changing them.

## 3. Translate

Choose machine translation, human translation, or both. A large language model (LLM) can prepare
translations for review. You can also work entirely on the website without a Gemini key.

<!-- tabs -->

### With the LLM

In **Settings → AI translation**, enter and save a Gemini API key. Use **Test Gemini key** to
check it, choose a model available to that key, and save any changed model or budget settings.
Then translate the uploaded strings:

```sh
npx quaso translate
```

The command waits for the job and reports failures. Successful translations become **green**:
accepted for download but not yet proofread. The quality checks catch structural problems such as
missing placeholders; a person still needs to check meaning and tone.

**Automatically translate on upload** is enabled by default. With a working Gemini key, later
uploads queue translations for new and changed strings. Upload does not wait for that work unless
you pass `--wait`. The LLM does not replace proofread translations; it can propose updates when
their source text changes.

### By hand

As the administrator, open a target language and select **Translate all**. Enter a translation and
select **Save**. Your saved translation is **blue**, meaning proofread. The editor shows any
problems you must fix before saving.

Invite others through **Team**. Contributors suggest changes for review; managers and
administrators can edit accepted translations directly. Refer to the
[website guide](website.md) for roles, review steps, and keyboard shortcuts.

<!-- /tabs -->

## 4. Download and check the result

Download the translations into your repository:

```sh
npx quaso download
```

With the default layout in this guide, the files appear under `src/locales/de/`,
`src/locales/fr/`, and `src/locales/ja/`. Check the changes in Git and load them in your game.
By default, downloads use current accepted translations. Pending suggestions are excluded, and missing
translations use source text. If the CLI reports a local edit, review or import it before downloading
again. Read [download safety](cli.md#quaso-download) before choosing to overwrite a local change.

The downloaded files do not require a live Quaso connection. Commit them and include them in your
build. Before releasing, check the languages in your configuration:

```sh
npx quaso status --fail-on untranslated,outdated
```

This command exits with code 7 if any selected condition is present. To require proofreading too,
add `green` to the list. Review the QA and pending counts separately; `--fail-on` does not accept
those conditions. Downloading by itself does not require every string to be translated or proofread.

For later source changes, upload again, wait for any translation job you need, and download the
result. You can use `npx quaso upload --wait` to wait for the job created by that upload. If no job
is created, the command does not translate existing work; use `npx quaso translate` when needed.

## Next steps

Choose the guide for your next task:

- [How translation works](concepts.md) explains accepted translations, suggestions, and source changes.
- [A complete workflow](workflow.md) covers reference languages and reviewing before you commit.
- [Add Quaso to your game](add-to-your-game.md) covers file paths and automated builds.
- [The CLI reference](cli.md) lists commands, options, output, and exit codes.
- [Backups, restores, and upgrades](operations.md) covers running an instance over time.
- [Migrate from Crowdin](migrate-from-crowdin.md) covers existing translations and approval states.
- [Contribute to Quaso](contributing/README.md) covers local development and project checks.
