# @quaso-i18n/cli

Quaso's command-line interface (CLI) uploads JSON and Markdown source files for **i18next and ICU MessageFormat** projects, downloads translations,
starts translation jobs, checks progress, and imports existing translations. Commands do not
prompt for input. JSON output and exit codes support scripts, continuous integration (CI), and AI
agents.

For ICU projects, enable **ICU MessageFormat** in the instance's **Settings → Placeholders** before
uploading. Leave it off for i18next JSON v4. Both use the same CLI commands and file mappings;
see the [message format guide](../../docs/file-formats.md#choose-your-message-format).

## Quick start

You need a Quaso instance and an API key with the `upload` scope. Create the key while signed in as an administrator,
in **Account → API keys**. The CLI runs on Node 22 or later and Deno 2.9 or later. Its published
package contains one JavaScript file with no separate runtime dependencies.

These examples follow current `main`. For a tagged release, use the matching CLI version and its
documentation. Install the CLI in your game repository:

```sh
npm install --save-dev @quaso-i18n/cli@main
export QUASO_HOSTNAME=translate.yourgame.com
export QUASO_API_KEY='your upload API key'
npx quaso init --languages de,fr,pl
```

Replace the hostname and key with your values. These environment commands use a POSIX shell.
Check the generated `quaso.config.json` before uploading: by default it reads English source files
from `src/locales/en/**/*.json` and writes translations to `src/locales/{lang}/{path}`.

```sh
npx quaso upload --dry-run
npx quaso upload
npx quaso download
npx quaso status --fail-on untranslated
```

Translate on the website between upload and download. With a Gemini key configured, use
`npx quaso translate` to start and wait for a translation job. Upload can also start a job when
automatic translation is enabled; use `npx quaso upload --wait` to wait for it.

For Deno, replace `npx quaso` with `deno run -A npm:@quaso-i18n/cli@main`.

## Connecting

`QUASO_HOSTNAME` accepts a hostname, which uses HTTPS, or a full URL such as
`http://localhost:8000`; plain `http://` is only for `localhost`, `127.0.0.1` and `[::1]`. The API
key comes only from `QUASO_API_KEY`; never commit it. With a key set, the CLI only connects to
`QUASO_HOSTNAME` and refuses a `hostname` that only the config file names, so a cloned repository
can't send your key to its own server.

For an administrator's key, the `read` scope permits download and status; `upload` also permits
upload, import, and translation jobs. Each key follows its creator's current permissions. A
manager's upload key can translate assigned languages but cannot upload, import, download, or
read status. Deleting the creator's account disables the key. Commit the config and package lockfile so the team shares the same
paths and CLI version.

## Commands

Run `npx quaso <command> --help` for every option. The main commands are:

| Command           | Purpose                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `init`            | Create a config; use `--from-crowdin` to convert a Crowdin layout.                        |
| `upload`          | Send source files and report changes; preview with `--dry-run`.                           |
| `download`        | Write translations; use `--at` for a published version from a past time.                  |
| `translate`       | Start a translation job and wait; preview its scope with `--dry-run`.                     |
| `status`          | Show progress; use `--fail-on untranslated,outdated,green` to enforce release conditions. |
| `import`          | Read existing translations as `--as green` or `--as blue`; preview with `--dry-run`.      |
| `version`, `help` | Print the version or command help.                                                        |

By default, download includes current accepted values, including outdated translations. Pending suggestions
are excluded. Missing translations use source text unless the config sets `untranslated` to
`omit`. Set `outdated` to `omit` to leave out older-source translations. Your app must supply
source-language text for omitted entries. `status --fail-on` has no condition for quality assurance (QA) errors; review those counts
separately.

Every command accepts `--json`, `--cwd <dir>`, `--config <path>`, `--help`, and `--version`.
With `--json`, the CLI writes one JSON result or handled error to stdout, with a `schemaVersion`.
Progress and errors go to stderr. Set `NO_COLOR` to disable terminal colors.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Success.                                                                |
| 1    | Unexpected error.                                                       |
| 2    | Invalid usage or config.                                                |
| 3    | Authentication or permission problem.                                   |
| 4    | Network or server failure; check the instance before repeating a write. |
| 5    | Invalid source file, such as a duplicate JSON key.                      |
| 6    | Some items were refused or failed; read the result for details.         |
| 7    | A `status --fail-on` condition is met.                                  |

## Safety

Download keeps files with local edits and exits with code 6; import the changes or review them
before using `--overwrite-local`. Keep `.quaso/` ignored by Git. `--prune` does not protect local
edits in files whose source is gone, so check its dry-run list before deleting them.

The CLI checks output paths before writing and refuses writes outside the project folder or over
source files. It does not follow HTTP redirects, start other programs, or run Git. Use previews,
review downloaded changes, and run your game tests before committing translations.

See the [full CLI reference](https://github.com/explodi/quaso/blob/main/docs/cli.md) for config
fields, command options, JSON results, retry behavior, and safety checks.
