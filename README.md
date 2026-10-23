<p align="center">
  <img src="packages/design-system/src/assets/quaso-cat.svg" width="256" height="208" alt="Quaso, a gray cat tucked into a croissant" />
</p>

# Quaso

Quaso is a self-hosted tool for translating games that use **i18next or ICU MessageFormat**, with
source text in JSON files or Markdown documents. Upload source text,
translate it with Gemini or your team, and download the translations into your game. Your game
loads those files without a connection to Quaso.

## Supported message formats

- **i18next JSON v4** (default): `{{name}}` placeholders, `$t(…)` nesting references, and
  plural keys such as `coins_one` and `coins_other`.
- **ICU MessageFormat**: `{name}` arguments and `plural`, `select`, and `selectordinal` blocks
  inside strings. Use it with i18next-icu or another ICU MessageFormat library. Enable
  **ICU MessageFormat** in **Settings → Placeholders** before the first upload.

The message format applies to the whole project, including Markdown documents. Both use the
same upload, translation, and download workflow. See the
[comparison and JSON examples](docs/file-formats.md#choose-your-message-format) to choose the
setting that matches your game.

## Quick start

Follow the [quick start](docs/README.md) to complete your first upload and download:

1. **Host Quaso** with [Docker Compose](docs/deploy-docker.md) or
   [Cloudflare](docs/deploy-cloudflare.md), and create an administrator account.
2. **Connect your game** with the command-line tool: install `@quaso-i18n/cli`, create an API key,
   and run `npx quaso init` with your target languages.
3. **Upload and translate** your source files. Use your Gemini API key for machine translation,
   or translate on the website.
4. **Download and check** the files with `npx quaso download`, then include them in your build.

To try Quaso locally before setting up a server, run [Quaso Quest](examples/demo-game/README.md).
This sample game includes a local Quaso instance and a test translator. Its generated translations
show the workflow; they are not real translations.

## How Quaso works

Each instance holds one project, its source language, and the languages you want to translate into.
The website is public: visitors can read source text and translations. Contributors suggest
changes; managers and administrators review them or edit accepted translations directly.

With a Gemini key and automatic translation enabled, uploads queue work for new and changed
strings. Machine translations can be downloaded before proofreading. The language model does not
replace proofread translations: changes to their source text can produce proposals for review.

By default, downloads use the current accepted translations, including translations marked outdated. Pending
suggestions are excluded. By default, missing translations use source text. Use status checks in
your build if you require complete or proofread translations before a release.

Read [How translation works](docs/concepts.md) for states, roles, and release checks, or
[Supported files and translation checks](docs/file-formats.md) for format rules.

## Find a guide

Choose the guide for your task:

| Task                                         | Guide                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Connect a game and automate its builds       | [Add Quaso to your game](docs/add-to-your-game.md)                             |
| Work through an upload, review, and download | [A complete workflow](docs/workflow.md)                                        |
| Translate or review on the website           | [Website guide](docs/website.md)                                               |
| Move existing translations from Crowdin      | [Migration guide](docs/migrate-from-crowdin.md)                                |
| Back up, restore, or upgrade an instance     | [Operations guide](docs/operations.md)                                         |
| Look up commands, settings, or API requests  | [CLI](docs/cli.md), [configuration](docs/configuration.md), [API](docs/api.md) |
| Develop Quaso                                | [Contributor guide](docs/contributing/README.md)                               |

## Working on Quaso

Use the Deno version in `.dvmrc` and Git to start a local development instance:

```sh
git clone https://github.com/explodi/quaso.git
cd quaso
deno install --frozen-lockfile
deno task dev
```

The development instance includes sample data, an administrator account, and a test translator.
Refer to the [contributor guide](docs/contributing/README.md) for setup requirements, checks, and the
source layout. Do not expose the development instance as a public server.

## Licence

Quaso is [MIT licensed](LICENSE). You pay for your hosting and any external services you use.
