# How translation works

Quaso keeps your source text, accepted translations, and proposed changes in one project. Knowing
which text a download uses helps you decide when a game build is ready to release.

## From source text to a game build

The usual workflow has four steps:

1. A developer writes text in the project's **source language** and uploads the files. The source
   language can be English, French, or another supported language tag.
2. People or a language model translate each **string**, a piece of text identified by its file
   and key. A plural group counts as one string with several forms. A Markdown document counts as
   one string for the whole file.
3. Managers review proposed changes and proofread machine translations.
4. A developer downloads the accepted translations and includes them in the game build.

Your game's repository remains the place to change source text. Translate and review on the website,
or maintain selected translation languages in the repository with `translationsInRepository`.
Downloads write ordinary files that your game can load without Quaso.

Start with the [quick start](README.md), or follow the [complete workflow](workflow.md) for a
worked example.

## Accepted translations and suggestions

An **accepted translation** is the value used in a download. It can be a machine translation that
has not been proofread, or a value approved or written directly by a manager or administrator.

A **suggestion** is a proposed change waiting for review. It does not replace the accepted value
until a manager or administrator approves it. This lets contributors propose a translation or
correction without changing what a game downloads.

The website uses three states:

| State             | Meaning                                                                                | Default download                                                             |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Red: untranslated | No accepted translation exists.                                                        | Source text, unless the download is configured to omit missing translations. |
| Green: translated | An accepted translation exists but is not proofread.                                   | The accepted translation.                                                    |
| Blue: proofread   | A person has approved the translation, saved it directly, or imported it as proofread. | The accepted translation.                                                    |

The state is separate from these flags:

- **Outdated** means the accepted translation was made for a different version of the source text.
- **Pending** means a proposed change is waiting for review.
- **QA** marks quality errors or stored warnings about meaning, repeated translations, or
  inconsistent translations. A flag can come from changed source text or constraints, an import
  with checks overridden, or a later check of accepted text.

A blue translation can be outdated, and a red string can have a pending suggestion. Neither flag
changes the accepted value. Download options can exclude outdated values. The [website guide](website.md#states-and-colours)
explains how these states appear in the editor.

## What happens when source text changes

An upload compares the new files with the current source. Existing translations stay available;
translations for changed source text become outdated. Removed strings are hidden from current
downloads rather than treated as new text to translate.

With a Gemini key and automatic translation enabled, new and changed strings can create a
translation job. By default, the job updates outdated translations, blue ones included: proofreading
holds for the source text it was made for. The outdated blue value is set aside, and comes back,
blue, if an upload brings that source text back. The LLM never replaces a blue value of the current
source text. An administrator can turn off updates on upload in **Settings → AI translation**. A
manually started translation job with outdated work in its scope updates it regardless of that
setting.

An ordinary upload returns before its translation job finishes. Use `quaso upload --wait` to wait
for a job created by that upload, or `quaso translate` to start and wait for a job on existing work.
Read the result: provider errors, quality checks, or a token budget can prevent work from finishing.

## What a download includes

`quaso download` reads the current accepted values. By default, it includes green and blue translations,
including outdated ones, and excludes pending suggestions and hidden strings. Set `outdated` to
`"omit"` in the configuration to leave outdated translations out. You do not need to
wait for a separate publication step to download an accepted edit.

When a translation is missing, the default is to write source text. The `untranslated: "omit"`
configuration instead leaves missing translations out so your game can fall back to its source
files. Refer to [file formats](file-formats.md#missing-translations) for plural, array, and document behavior.

The CLI checks existing translation files for local edits before replacing them. If a file has a
conflict, it keeps that file and reports what needs review. Import the edits or deliberately choose
to overwrite them; see [download safety](cli.md#quaso-download). Languages listed in
`translationsInRepository` are imported on upload. They still take part in downloads, so upload
their local changes before downloading newer values.

Historical downloads with `--at` use retained published file versions. They are a different path
from current downloads, and their availability depends on the file history settings. Keep release
files in your own repository if you need to reproduce an older build.

## Choose your release checks

A completed download does not mean every translation is complete, current, or proofread. Add a
status check to your build based on your release requirements:

```sh
npx quaso status --fail-on untranslated,outdated
```

This check allows green translations but fails when a string is missing a translation or is
outdated. Add `green` if every translation must be proofread. A matching condition produces exit
code 7. The supported conditions are `untranslated`, `outdated`, and `green`; QA findings and pending
suggestions need a separate review of the status output or a check using `--json`.

By default, status displays every language on the instance, but `--fail-on` checks the languages
in your CLI configuration. `--language` changes that selection. Upload first so that the configured
languages exist on the instance. Refer to [CLI status](cli.md#quaso-status) for details and to
[automated builds](add-to-your-game.md#ci) for an example.

## People, keys, and access

Each Quaso instance is public. Visitors can read source strings, translations, history, and activity
without signing in. Creating an account does not by itself grant permission to edit translations.

The main roles have these responsibilities:

| Role          | Work in Quaso                                                                           |
| ------------- | --------------------------------------------------------------------------------------- |
| Contributor   | Suggest translations and corrections for review.                                        |
| Manager       | Edit and review translations, run translation jobs, and maintain context and terms.     |
| Administrator | Manage the project, team, settings, API keys, and backups, as well as translation work. |

Language assignments limit contributors and managers. Administrators can work in every language.
Anyone signed in can create personal API keys in **Account → API keys**. Each key is limited by both
its scope and its creator's current role. Use an administrator's key for the full CLI workflow:
`read` permits status and downloads; `upload` also permits source uploads, imports, and translation
jobs. A manager's upload key can start translation jobs in their assigned languages, but cannot
upload, import, or download files. Demoting or deleting the creator limits or disables their keys.
The [website guide](website.md#joining-and-managing-the-team) covers
joining a team and the full permission rules.

## Source and reference languages

The **source language** defines the uploaded text and file structure. **Target languages** are the
languages you translate into. The CLI's language list selects which languages it translates and
downloads; uploads add any of those languages that the instance does not yet have.

**Reference languages** supply additional translations as context for the LLM. Choosing a reference
language does not change the source language or replace source text during download. Select them
in the LLM settings when a second language helps explain the intended meaning.

## Context, reuse, and meaning checks

Descriptions explain how a string is used. For JSON sources, keep them in adjacent description
files or configured description keys and upload them with the source. The LLM can report unclear
source wording so that a developer can add context. See [CLI upload](cli.md#quaso-upload).

**File context** explains what a whole file is, and **folder context** what every file in a folder
and its subfolders is, such as "Store page texts" for `store/`. Managers write both in **Settings →
Files & length limits**. The LLM reads the contexts of a file's folders, outermost first, then the
file's own, in the prompt's `%fileContext%`. A folder's context stays when its last file is
removed, and applies again if files return to it. To give files a folder of their own on the
instance, set `folder` on their entry of `quaso.config.json`; see [The config file](cli.md#the-config-file).

Optional **translation memory** reuses an accepted translation for an exact matching source,
kind, and plural form structure. Reused results are green and can still need review for context.
This option is off by default. A matching translation is also useful context in model requests.

Optional model checks report possible changes in meaning, missing content, or grammar problems.
They produce warnings for review, rather than proof that a translation is correct. These checks
are off by default. Glossary tools can suggest terms, and style-guide jobs can draft language
instructions; a person reviews the results before saving them. The [website guide](website.md)
explains these tools and the separate editor suggestions.
