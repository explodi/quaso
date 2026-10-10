# From your repository to every language

This is the [quick start](README.md) in more depth: a walk through every screen, from your first
upload to a reviewed commit. Use it after [deploying with Docker](deploy-docker.md) or
[deploying on Cloudflare](deploy-cloudflare.md). If you already use Crowdin, start with
[the migration guide](migrate-from-crowdin.md), then return here.

You need an instance with an administrator account, Node 22 or later with npm, and
i18next JSON v4 source files in your repository. The examples use English sources in
`src/locales/en/`, Spanish and French targets, and `translate.example.com`. Replace the
hostname and language tags with yours. The operator must configure an LLM provider and
key before the auto-translation step.

## 1. Connect the repository

In Quaso, open **Settings → API keys** and create a key with the **upload** scope. Copy
the secret when it appears; it is shown once. This scope permits uploads, imports and
translation jobs as well as downloads.

Run in your game's repository root:

```sh
npm install --save-dev @quaso-i18n/cli
```

The CLI should appear in `devDependencies`. Keep the package lock so the team uses the
same version. Create `.env` beside `package.json`:

```dotenv
QUASO_HOSTNAME=translate.example.com
QUASO_API_KEY=qso_replace_with_the_key_you_copied
```

Add `.env` to `.gitignore`. Merge these scripts into `package.json`, keeping your existing
scripts:

```json
{
  "scripts": {
    "quaso": "node --env-file=.env node_modules/@quaso-i18n/cli/quaso.mjs",
    "l10n:upload": "npm run quaso -- upload",
    "l10n:download": "npm run quaso -- download"
  }
}
```

Node [loads `.env` explicitly](https://nodejs.org/download/release/v22.21.0/docs/api/cli.html#--env-filefile);
the CLI itself reads the process environment. These tasks work without shell-specific
`export` commands. Run:

```sh
npm run quaso -- init --languages es,fr
```

You should see `quaso.config.json` created. Review it: sources should match
`src/locales/{source}/**/*.json`, and translations should go to
`src/locales/{lang}/{path}`. Nested files such as `en/menus/play.json` then download to
`es/menus/play.json`. For existing folder names such as `zh` for Simplified Chinese, use
`--languages es,fr,zh-Hans --language-mapping zh-Hans=zh` when initializing. If a config
already exists, review it instead; `init` does not overwrite it.

## 2. Upload and check the files

```sh
npm run l10n:upload -- --dry-run
npm run l10n:upload
```

The preview lists file and string changes without saving them; the second command
applies them. Check the listed files before continuing. An unfiltered upload hides
previously uploaded files that are now absent; it retains their translations and history.
Uploading never edits your local English files.

Open **Sources** on the website. You should see the repository folders, string and word
counts, and the last upload change. Open **Dashboard**: each target language shows two
percentages, **translated** and **proofread**, counted in source words. Words left counts
the source words with no accepted translation. Existing translations of changed sources
can instead be marked outdated, so check that badge too. If automatic translation is
enabled, the upload can start a job; disable it in Settings while following this workflow
manually.

## 3. Translate one language yourself

Open Spanish and choose **Translate all**. The editor defaults to **To do first**:
untranslated strings, outdated translations, then the rest. Select a string, type its
translation, and press **Save** or Ctrl/⌘+Enter. A manager's saved translation is proofread
(blue); Ctrl/⌘+Enter also moves to the next string to do.

The queue keeps its opening order while you work. **Previous to do** and **Next to do**
skip entries completed since it opened; the counter reaches **Done** when its initial
to-do entries are finished. Reload to compute a new queue. Review any outdated proofread
strings and QA errors. Return to Spanish's page: when every source word has a current,
proofread translation, both percentages read **100%**.

## 4. Choose the reference language

As an administrator, open **Settings → LLM translation → Reference languages**, select
Spanish, and save. The prompt can then include Spanish translations and mark proofread
references. Keep the project's output rules and placeholder instructions when editing
its prompt. A manager can see the reference names in the translation dialog; changing
Settings requires an administrator.

## 5. Auto-translate the rest

From Dashboard, choose **Auto-translate**. Its defaults are all languages, all files,
**Untranslated only**, and **Update outdated translations**. From a language page it
selects that language; from the editor it also selects the current file or folder.

The references line should name Spanish. Review the per-language estimate and the words
beside each file and folder. Checking a folder selects its descendants; clearing a child
leaves the folder partly checked. **All files** controls the whole tree. Arrow keys move
and expand folders, and Space toggles selection. Changing scope updates the estimate.

Press **Start translation**. The dialog closes, and the job indicator shows progress as
you navigate. Open its job link for failures or skipped strings. Accepted LLM translations
are green; outdated blue translations receive proposals for review. When the job finishes,
the message announces the result and the dashboard refreshes. A fully translated language
can read **100% translated** while its proofread percentage is lower. Review the green
translations before treating them as human-checked.

## 6. Download, inspect and commit

```sh
npm run l10n:download -- --dry-run
npm run l10n:download
git diff -- src/locales
```

The preview reports the files it would write. Download writes only changed files and
reconstructs their keys and formatting from the source. Entries without an accepted
translation use English; pending proposals are not downloaded. Green translations are downloaded:
you can ship them before anyone proofreads them, and a later download brings the proofread
versions. Publication may take up
to one minute after a write, so retry once the instance has published the latest version
if a just-saved change is not present yet.

Check the diff and test the game, including plurals and placeholders. Run download again;
it should say **Everything is up to date**. Commit the reviewed config, package files and downloaded
translations with your normal git workflow. Keep `.env` out of the commit.

## Deno project tasks

For a game using Deno 2.9 or later for tasks, keep the same npm-installed CLI and Node runtime. Merge into
`deno.json`:

```json
{
  "tasks": {
    "l10n:upload": "node node_modules/@quaso-i18n/cli/quaso.mjs upload",
    "l10n:download": "node node_modules/@quaso-i18n/cli/quaso.mjs download"
  }
}
```

Run `deno task --env-file=.env l10n:upload` or
`deno task --env-file=.env l10n:download`. Deno [loads the task's environment](https://docs.deno.com/runtime/reference/cli/task/);
Node runs the supported CLI bundle.

## Troubleshooting

- **Missing key or hostname:** check `.env` and run through the task, which loads it.
  A download-only key cannot upload or start jobs; ask an administrator for upload scope.
- **No files or wrong folders:** check the source glob, source tag and `languageMapping`
  in `quaso.config.json`; use an upload preview before applying corrections.
- **Auto-translation unavailable:** ask the operator to configure the provider/key.
  Inspect the job details for budget, provider or QA failures before retrying work.
- **Progress differs from another tool:** Quaso counts source words, treats a plural group
  as one string, and excludes literal/reference-only entries. Compare a sample of keys.
- **An expected translation is missing locally:** verify it is accepted, the download
  language is in the config, and publication has caught up. See [CLI safety and errors](cli.md#safety).
