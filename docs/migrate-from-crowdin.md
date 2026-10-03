# Migrate from Crowdin

Move a copy of your repository first, compare the result, and switch the team's workflow
after it passes. You need a Quaso instance and upload API key, your English i18next JSON
v4 sources, `crowdin.yml`, and permission to export Crowdin translations. This guide uses
`src/locales/en/` sources and the matching `src/locales/<language>/` exports.

Follow [Connect the repository](workflow.md#1-connect-the-repository) to install the Beta 2
CLI, load the key from `.env`, and add the project tasks. Stop before its `init` command:
convert your existing layout below instead. Keep the original repository and Crowdin
exports for comparison. In Quaso, disable automatic translation while importing.

| Crowdin                                       | Quaso                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| Approved                                      | Proofread (blue)                                                             |
| Translated                                    | Translated, awaiting proofreading (green)                                    |
| Pre-translate                                 | Auto-translate                                                               |
| Sources                                       | Sources, displayed in repository folders                                     |
| Delete obsolete sources / `--delete-obsolete` | Missing sources are hidden on a full upload; translations and history remain |

Quaso's blue and green have different meanings from Crowdin's familiar colors. Explain
the table to reviewers before switching.

## 1. Convert and review the layout

Run from your copied game's root, where `crowdin.yml` lives:

```sh
npm run quaso -- init --from-crowdin crowdin.yml
```

You should see the proposed config, warnings, and `quaso.config.json` written. The YAML
is read only; credentials are not copied. If a Quaso config already exists, review that
file instead of expecting `init` to replace it.

Conversion supports `%two_letters_code%`, `%locale%`, `%language%`, original file names
and paths, ignore patterns, and per-file `languages_mapping`. It infers languages from
local target files and mappings. If no exports are present, provide your known target
tags with `--languages es,fr,zh-Hans` and mappings such as `--language-mapping zh-Hans=zh`.
Review a proposed `zh-Hans` tag against your actual Chinese variant.

Check each source glob and translation pattern. `**/%original_file_name%` keeps folders
below the source glob's base; `%original_path%/%original_file_name%` includes that base
and requires `preserve_hierarchy: true`. Unsupported placeholders and recursive layouts
that would flatten folders are reported rather than guessed. If nothing is convertible,
no config is written; create the layout with [CLI init options](cli.md#quaso-init).
The converter requires `base_path: .` or an omitted base path.

Compare one nested file's Quaso download destination with its existing Crowdin export
path for every language, especially mappings such as `zh-Hans` → `zh`. Correct the config
before importing. See [Crowdin's layout rules](https://crowdin.github.io/crowdin-cli/advanced).

## 2. Upload the source

```sh
npm run l10n:upload -- --dry-run
npm run l10n:upload
```

The preview should list exactly your English source files. The upload adds the target
languages needed by the imports. Check **Sources** and Dashboard for the expected files
and counts. Uploading does not edit local source files.

## 3. Export two separate copies

Create two new, empty export folders. These example paths must not already exist:

```sh
mkdir /tmp/quaso-crowdin-approved /tmp/quaso-crowdin-all
crowdin download translations --config crowdin.yml --base-path /tmp/quaso-crowdin-approved --all --preserve-hierarchy --export-only-approved --skip-untranslated-strings
crowdin download translations --config crowdin.yml --base-path /tmp/quaso-crowdin-all --all --preserve-hierarchy
```

The first folder should contain only approved entries; the second contains the full
export. `--all` permits exports without local source files under these temporary roots.
Crowdin's [download reference](https://crowdin.github.io/crowdin-cli/commands/crowdin-download-translations)
explains that `--export-only-approved` alone fills unapproved entries with source text;
`--skip-untranslated-strings` omits those entries. Add your normal branch option if you
use a Crowdin branch.

Check the exported paths before importing: with `src/locales/{lang}/{path}` in Quaso's
config, each export root must contain `src/locales/es/common.json`, for example. If
Crowdin exported a different layout, adjust your export configuration or prepare a
separate copy matching the Quaso pattern. Do not copy approved-only files into the
working tree over the full translations.

## 4. Import approved, then all translations

```sh
npm run quaso -- import --as blue --from /tmp/quaso-crowdin-approved --dry-run
npm run quaso -- import --as blue --from /tmp/quaso-crowdin-approved
npm run quaso -- import --as green --from /tmp/quaso-crowdin-all --dry-run
npm run quaso -- import --as green --from /tmp/quaso-crowdin-all
```

Each preview reports the values it would import. Approved values become blue in the
first pass. The second pass adds green translations and preserves existing blue values.
Do not add `--overwrite`. Both exports are read only; the project config and English
files still come from your repository.

Source-identical values are skipped because Crowdin can use English for untranslated
entries. If an identical value is intentional, review it and import only that
file/language with `--keep-identical`. Unknown keys are skipped. QA failures are listed
with exit code 6 while valid entries still import; fix or retry the affected languages.

## 5. Compare before switching

```sh
npm run quaso -- status --json
npm run l10n:download -- --dry-run
npm run l10n:download
git diff -- src/locales
```

Check a known approved key is blue, an unapproved translation is green, and an
untranslated key still uses English after download. Compare nested paths, plural forms,
placeholders and language coverage in the game. Plural groups count as one Quaso string;
literal/reference-only entries and skipped source-identical values can explain count
differences. Download follows source formatting, so a first download may reformat files.

Copy project/language instructions, glossary terms and reference-language choices into
Settings. Adapt your AI prompt to Quaso's placeholders and output rules using
[the prompt mapping](move-from-crowdin.md#prompt-and-context-mapping). Translation-file
imports do not carry Crowdin comments, tasks, accounts, history, screenshots or external
translation memory. Quaso starts its own history at import.

## 6. Switch the workflow

Follow [the repository-to-language workflow](workflow.md#3-translate-one-language-yourself)
to review one language, use it as an LLM reference, translate the rest, and download and
commit. Invite contributors and managers, assign their languages, and explain accepted
translations versus pending suggestions. Enable automatic translation only after the
comparison and a small prompt trial pass.

Keep Crowdin read-only and retain both exports and a Quaso backup for an agreed comparison
period. Use one system for new edits. Once the team accepts the copy, replace its former
upload/download tasks with the Quaso tasks. Do not delete the old exports as part of the
migration.

## Troubleshooting

- **Conversion reports unsupported fields:** review each warning; supply explicit tags,
  mappings or globs instead of guessing a destination.
- **Import cannot find files:** compare the export root plus Quaso's translation pattern
  with an actual exported filename. `--from` changes the root, not the pattern.
- **Language missing on the instance:** upload the configured sources/languages before
  importing. The CLI checks all requested languages before the first import.
- **Approved count is smaller:** inspect skipped English-identical entries and QA failures;
  compare plural groups and active keys, rather than treating raw totals as equivalent.
- **A blue translation appears wrong:** verify the approved-only export contains only
  approved entries, then correct the affected key through review. Keep the full export
  separate and retain the comparison copy.
