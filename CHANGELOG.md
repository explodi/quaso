# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.
Release candidates are for deployment and migration testing. The team decides when to tag 1.0.0.

## [Unreleased]

### Added

- ICU case editor: a string whose English has blocks is translated case by case, one field per
  case (`female › one`, with the case's English above it) and per text around blocks, the syntax
  locked and plural cases for the target language. Fields hold plain text; braces and apostrophes
  are quoted as ICU needs on save. **Edit as text** shows the ICU in one input; a translation the
  fields can't show (other blocks or cases, or invalid ICU) opens as text with a note. Tab, chips,
  the shortcuts and undo work per field. Core adds `icuFieldForm`, `writeIcuFieldForm` and
  `quoteField`.
- ICU editor help: a source with blocks shows as a tree, each block's cases on lines of their own
  under their keys, also in the history, suggestions and other languages. Above the input, the
  target language's plural and ordinal cases for each plural block, with example numbers. Under
  it, **Preview in each case**: the translation in every case, with an example number for `#`,
  or where it stops being valid ICU. **Copy the English** gives plural and selectordinal blocks
  the target language's categories instead of the English's. Core adds `formatIcu`,
  `icuPreview`, `icuSyntaxError`, `icuWithLanguageCases`, `exampleNumber` and
  `pluralCategoryOf`.
- Declared arguments: with ICU MessageFormat on, `arguments` in `quaso.config.json` declares the
  arguments a game passes that the English may not show, such as the gender of a post's author,
  with their select cases, a description and optional `files` and `keys` globs. A translation may
  add a select block on one, leave out the English's or restructure it: the checks compare each
  case with the English, name the case of a problem found in only some, and refuse a case that
  isn't declared or a block without `other`. The LLM gets each string's arguments and a rule to
  agree with them where the language needs it, with a neutral `other` case, and to write one text
  where it doesn't. The editor shows them beside the source, and **Vary by …** writes a select
  block into the translation. Uploads to a project without ICU keep them and warn. Schema version
  7 stores them with each string. Instances on the default prompt get its `arguments` field on the
  next request. `deno task test:llm` takes `--project` and `--icu` to evaluate another project.
- Converting a project from i18next to ICU MessageFormat: `quaso convert-to-icu` converts the
  instance's strings, translations and pending suggestions in one transaction, then the source
  files in place with the same rules, and turns on **ICU MessageFormat**. `{{name}}` becomes
  `{name}`, a plural group (`coins_one`, `coins_other`) becomes one `coins` string with a plural
  block of each language's own forms (`_zero` as `=0`, ordinals as `selectordinal`), and braces,
  `#` and apostrophes are quoted where ICU would read them. Colours, authors, timestamps, outdated
  flags, history and comments stay; each converted text gets a history event. Nesting references,
  i18next formats and other text ICU can't say are refused with their file, key and language, and
  nothing changes until they are fixed. `--dry-run` reports both sides, including translations
  that would fail the ICU checks. `POST /api/v1/conversions/icu` converts the instance alone, for
  administrators and API keys with the `upload` scope. See
  [Move an i18next project to ICU MessageFormat](docs/move-to-icu.md).
- A guide, "Gender, plurals and other variants": which tool fits each kind of variation (plural
  and ordinal blocks, a select in the English, declared arguments for agreement only other
  languages need, alternatives, fragments the app joins), why a string must be a whole sentence
  and each case a whole phrase, what the LLM is told, and what the checks refuse.
- Folder context: managers write a context for a folder in Settings → Files & length limits, and
  the LLM reads it with every file in the folder and its subfolders: the folders' contexts,
  outermost first, then the file's own, in `%fileContext%`. `PATCH /folders` writes one; a blank
  context removes it. A `folder` on a `files` entry of `quaso.config.json` keeps the entry's files
  in a folder of their own on the instance (`game/menus/main.json`) without changing where
  translations go. Schema version 6 adds the `folders` table.
- ICU MessageFormat: with **ICU MessageFormat** on in Settings → Placeholders, as for
  i18next-icu, JSON strings and Markdown documents are read as ICU. Arguments (`{name}`,
  `{n, number}`) and `#` are placeholders, and blocks such as `{style, select, …}` and
  `{n, plural, …}` are checked case by case: a new `icu_structure` error for a missing, broken or
  changed block or select case, plural cases by the target language's categories, and
  placeholders compared with the English case of the same key. The editor shows a block's syntax
  apart from its text, and the LLM is told how to translate ICU.
- Markdown documents: a source file ending in `.md` or `.markdown` is translated whole, as one
  string whose key is empty and whose file is its identity. Point a `files` entry of
  `quaso.config.json` at them (`text/en/**/*.md` with `text/{lang}/{path}`), beside the JSON
  files. Uploads, the editor (the file name as the title, a taller input and a paragraph counter),
  imports, translation jobs (one request per document, marked as a whole file in the prompt) and
  downloads (the translation with one final newline) work as for JSON strings; a document with
  nothing to write, untranslated or outdated with `omit`, is deleted from the repository so the
  app falls back to its source language. A new `paragraphs` check replaces the line-break count
  for documents: a translation keeps the number of paragraphs. Instances on the default prompt
  get its document rule on the next request.
- Markdown checks for documents: `markdown_verbatim` (an error when code, a link or image URL or a
  front matter key isn't kept as in the English), `markdown_structure` (an error when a paragraph
  becomes another kind of block, such as a heading of another level) and `heading_anchor` (a
  warning when a link to a heading of the file leads nowhere after the heading was translated).
- Updates of outdated translations send the LLM the English the translation was made for
  (`outdatedEnglish` in the prompt), so it changes only what the English change requires. For a
  document, paragraphs whose English didn't change keep their translation exactly. Instances on
  the default prompt get the new rules on the next request.
- A document may have at most 6,000 words for the LLM: upload warns about a longer one, and jobs
  skip it with an error instead of sending a request that would time out.
- The editor shows a document in three tabs: the whole file, side by side by paragraph, and a
  rendered preview. An outdated document's notice and the review queue's LLM proposals show only
  the changed paragraphs.

- LLM suggestions in the editor: managers who translate by hand turn on the **LLM suggestions**
  switch and see the LLM's translation under the input, while they type their own. The editor asks
  about the open string and the next three to do in one request, and keeps asking ahead as they
  move on to reduce waits. A suggestion asks the model for as little
  thinking as it allows, isn't retried and ends after 30 seconds. `POST /llm-suggestions` takes up
  to eight strings of a language.
- Models are chosen from a drop-down of what the provider offers, in Settings (the project's and
  the meaning checks') and in the Auto-translate dialog, instead of typed. Models for speech,
  images, audio and robots aren't offered. Without a list, a text field remains.
- A model of its own for the editor's LLM suggestions (`llm.suggestionModel`, Settings → AI
  translation → Model for editor suggestions): someone is waiting for a suggestion, so a faster
  model suits it, while jobs keep the project's model. Left blank, suggestions use the project's.
- Glossary bootstrapping suggests recurring domain terms from the source corpus, counts current
  language renderings and shows inconsistencies with source examples. Managers accept, edit or
  dismiss suggestions and retranslate affected green strings with the agreed glossary.
- Style-guide jobs draft per-language instructions from proofread translations for an
  administrator to edit and save. Existing instructions and proofread text stay intact until review.

- Model meaning checks compare source and translation and retain structured QA warnings.
  Checks run manually per string/file/language or automatically on configured save/approval
  events, with model, colour and budget controls. Reference-language notes can be collected
  during translation without an extra request. Schema version 5 adds durable quality jobs,
  suggestion checks and explicit budget accounting while preserving accepted translations.

- Repository descriptions: upload reads adjacent `.descriptions.json` sidecars or configured
  description-suffix keys and attaches context without changing source files. Translation jobs
  retain model ambiguity notes, show source warnings and list keys needing a description. Schema
  version 4 adds source warnings and job notes; existing translation data remains intact.

- Optional translation memory copies exact current source/kind/plural matches as green, records
  their origin in history and reports reused job items without spending model tokens. Prompts
  include green matches too, and consistency warnings find differing translations of identical
  sources across files. Schema version 3 preserves job progress while adding reuse counts.

- File-wide `duplicate_translation` QA warnings name different source strings that share a
  translation. Both affected keys appear in the QA filter; corrections clear both warnings.
  Schema version 2 stores contextual check results and clears them when translations change.
  Startup migrates existing databases automatically; retain a backup before upgrading.

- Personal API keys: everyone signed in creates, copies once and revokes their own keys on their
  account page (Account → API keys), which says which CLI commands their role allows.
  Administrators still see and revoke everyone's keys in Settings, now with who created each.

- On Cloudflare, the Worker serves the website without waiting for the container to start.
  Opening the website starts the container. A progress bar estimates the wait from the previous
  start time. A tab reopened after the container sleeps shows the same progress above the page.
  `/wake` reports whether the server is ready.
- The CLI checks for a sleeping instance before its first request and waits for it to start,
  showing progress. A failed or slow start can still time out.

- Successful builds on main publish the CLI to npm under the tag `main`, as
  `<version>.main.g<commit>` (`-main.g<commit>` after a stable version), next to the image's
  `sha-<commit>`.
- `"untranslated": "omit"` in `quaso.config.json` (`untranslated=omit` on `GET /export`): download
  leaves out untranslated strings, missing plural forms and incomplete arrays instead of writing
  the source text, for apps whose i18n falls back to the source language. Published files are
  unchanged.
- `quaso translate --qa` (`qa` in a job's scope) also translates again the green translations that
  fail the quality checks, such as values imported with `--allow-qa-errors`. Blue ones never
  change.
- Placeholders some languages leave out (`syntax.optional` in Settings): a placeholder such as an
  English article (`{article}`) may be missing from the translations of the languages listed,
  without a QA error, and the prompt tells the LLM it may leave it out there. Instances on the
  previous default prompt get the new one.
- Other placeholder delimiters (`syntax.extra` in Settings): placeholders an app fills in itself,
  such as `{name}` beside i18next's `{{count}}`, are found, checked, shown as chips and kept by the
  LLM like i18next's. Each string in the prompt lists its `placeholders`; instances on the
  previous default prompt get the new one.
- `quaso import --allow-qa-errors` (`allowQaErrors` in `POST /imports`) can import values that fail
  quality checks. The result lists their errors as `flagged`. Other import rules, including the
  handling of empty values, unknown keys, and existing proofread translations, still apply.
- An outdated string shows a banner in the editor: the English changed after it was translated,
  players still get the old translation, how the English changed (as a word diff), and what to do
  about it. Wherever outdated counts appear, they say the same.
- Quality warnings for slips that are easy to miss: a missing or added tag (`<b>`, `<1>`), a space
  or line break at either end that the English doesn't have (or the other way round), a different
  number of line breaks, two spaces in a row, and a different `?`, `!`, `…` or `:` at the end. The
  editor shows the English's spaces and line breaks at either end as `·` and `↵`, and a placeholder
  chip turns red while the translation lacks it.
- A translation estimate (dry run) says how many strings get each treatment: `work.translate`,
  `work.retranslate`, `work.update` (outdated green, rewritten) and `work.propose` (outdated blue,
  a proposal). The Auto-translate dialog and `quaso translate --dry-run` show it.

### Changed

- Upload tells local translations of new strings from those of changed strings. A changed string's
  local translation still translates the previous source text, so upload warns about it and offers
  the import command only for when it was updated along with the source. Languages with the same
  count share one line, and the import command leaves out `--language` when it covers every
  language. In `--json`, `localTranslations` reports `new`, `changed`, `newFiles` and
  `changedFiles` in place of `strings` and `command`.
- A limit that names a string the server doesn't have says it does nothing and how to fix it.
- Auto-translate and `quaso translate` give outdated proofread translations a proposal whenever
  their scope includes outdated work, whatever the upload setting "Propose updates for outdated
  proofread translations" says. The two outdated settings apply to uploads only.
- Progress bars are drawn in pixels. Translation progress dithers from full to empty: solid blue
  for proofread words, a green checkerboard for translated ones, sparse dots for the rest. Bars
  of one value (jobs, the token budget, waking up) are a solid fill ending in a thick tick over a
  row of thin ticks, and move a tick at a time. `--bar-track` is the colour of the dots.

- An API key never does more than the person who created it may do now: a demotion narrows it,
  and deleting the account disables it. Keys created on the server (`quaso token create`) act by
  their scope alone, as before. Create CI keys with an administrator account.

- On Cloudflare, a request that wakes the container waits for the whole start (up to two minutes)
  instead of failing with a 503 after about 30 seconds.
- `/config.json` and `/robots.txt` are files in the website's build instead of server routes.

- The LLM's answer schema requires the plural forms every plural string of the batch needs, so
  structured output can't skip one (French `many`, for 1000000, went missing otherwise).
- `cf:setup` and `cf:deploy` deploy a release published on Docker Hub as `docker.io/<image>`,
  which Cloudflare pulls itself, instead of copying it into the account's registry with Docker.
  Deploying needs no Docker any more, and no longer fails where Docker's containerd image store
  reports a pulled multi-platform image without a platform.
- `quaso import` skips empty values (`""`) as untranslated, as `skippedEmpty`, even with
  `--allow-qa-errors`: Crowdin writes untranslated entries that way when asked to skip them.
- `quaso import` ignores plural forms a language doesn't use, such as `_one` in Japanese, instead
  of refusing the whole translation, and counts them as `droppedForms`.

### Removed

- The server's remote-storage mode (`SERVICES_URL`, `SERVICE_TOKEN`) and its `LOCATION_HINT`
  setting. The Cloudflare Worker no longer serves the internal API that mode called; a Cloudflare
  deployment keeps its data in D1 and R2 (`deno task cf:setup`).
- The `published/<language>/<file>` copy of each file's latest version in the object store.
  Downloads have always read the immutable `versions/` objects, so nothing read these copies.
  Existing ones can be deleted.

### Fixed

- The model reads only proofread translations of the current source text: the reference
  languages, the identical strings and the neighbours no longer include green translations, which
  were another model's guesses, and the neighbours no longer include outdated ones. A string with
  no proofread reference goes with its source text alone. The Auto-translate dialog says
  "proofread strings only".
- Auto-translate's estimate no longer takes half a minute, or fails with "The project is busy"
  while a job runs: it reads its batches' prompt context eight at a time, and no longer starts
  over when the project changes as it reads (an estimate may mix revisions). Start translation
  stays enabled while the estimate for the chosen scope refreshes, which it shows, and the estimate
  no longer refreshes on every focus of the window.
- Saving a translation no longer rereads every translation in the project to refresh the
  duplicate and consistency warnings: it checks again only the translations in the same file and
  language, and those with the same English. Uploads, renames and restores still check everything.
- Pages stop polling the server after five minutes without a key, click, scroll or touch, so an
  open tab nobody looks at no longer keeps the server awake; the first input after that refreshes
  what's on screen.
- Saving several strings in a row no longer fails with "wasn't saved. Open it to try again.": the
  server's writes take turns instead of racing for the project's revision, so saves sent together,
  LLM suggestions and a running job wait for each other rather than running out of retries.
- The editor's quick re-polls of the project, its files and their progress no longer read the
  whole project each time: the server keeps the answers in memory while the project's revision
  stays the same, and reads one row to check it. The cache has a memory budget, a default time to
  live, and evicts expired entries first, then the least recently used. A refresh of the
  contextual checks (duplicates, consistency) now raises the revision too.
- The string list shows a string's "Saving…" in full, with a spinner, while its save runs in the
  background; the key and file name are cut short first.
- LLM suggestions no longer fail with "The project is busy" while background saves run: the
  server tries recording a suggestion's usage three times, then keeps the paid-for answer without
  it and logs that. The editor sends a request the server couldn't answer again up to three
  times, after 1, 2 and 4 seconds, and keeps six suggestions ready or on their way ahead of the
  translator instead of three, so they are more often there on arrival.
- A server with many files starts in seconds. It used to publish before it answered, reading
  every file's stored objects one by one: with a few thousand files on Cloudflare, a start took
  over an hour and every request got 502. Starting now only schedules the next wake-up, and a
  pending publication runs in the background. A publication writes only the files that changed,
  eight at a time, and reads nothing from the store; a restore checks the store once with a
  listing and rewrites the current versions it lacks.

- On Cloudflare, a deploy reaches the server too: the container a previous deploy started is
  restarted on the new image once it isn't busy. Cloudflare gives a new image only to the next
  start, and a server in use never sleeps, so the website could call endpoints its server didn't
  have yet ("This server doesn't support this yet"). A change of secrets restarts it too.
- In Safari, the links in the header's menus (Team, Settings, Account and the others) work: the
  menu closed before the click reached them, because Safari doesn't focus a clicked link.

### Security

- The CLI sends an API key only to a server you chose: with `QUASO_API_KEY` set, the instance
  must come from `QUASO_HOSTNAME`, and a `hostname` that only `quaso.config.json` names is
  refused (`missing_hostname`, exit code 2). A cloned repository could otherwise point the CLI,
  and your key, at its own server. **Breaking:** a team that commits `hostname` and runs the CLI
  with a key must set `QUASO_HOSTNAME` too, in CI and on every machine.
- The CLI refuses plain `http://` addresses (`invalid_hostname`) except `localhost`,
  `127.0.0.0/8` and `[::1]`, so a key never crosses the network unencrypted. Development
  servers such as `http://localhost:8000` keep working.
- A restore reads at most 512 MiB of JSON, counted as a gzip backup decompresses, and refuses a
  larger document with 413 `payload_too_large`. A small gzip body could otherwise expand until the
  server ran out of memory, including through `POST /restore` with the setup key.
- New password hashes use 600,000 PBKDF2-HMAC-SHA-256 iterations, OWASP's figure for SHA-256,
  instead of 210,000 (its figure for SHA-512). A password stored with fewer iterations is rehashed
  the next time its owner signs in with it.
- The CLI refuses a symbolic link anywhere on the path of a file it reads, writes or deletes,
  even one that stays inside the project (`unsafe_path`, exit code 2). A repository could commit
  `locales/en/x.json -> ../../.env` and have `quaso upload` send the ignored `.env`, or link a
  translation file to `.git/hooks/pre-commit` and have `quaso download` write it. Replace such
  links with regular files or folders.

## [1.0.0-rc.2] - 2026-10-08

### Added

- Project glossary terms with per-language translations and locked terms, translator comments and
  source-problem reports, and community requests for new languages.

### Changed

- Beta 2 stores provider and retention configuration in Settings and uses independently
  salted PBKDF2 passwords. Beta 1 password hashes are incompatible; Beta 2 requires a fresh
  instance. The schema starts again at `001`; Beta 1 SQLite and JSON backups are rejected.
  Remove old development data before starting Beta 2 (`deno task dev:reset`).
- Quaso runs on Deno again: `deno task` replaces `bun run`, the server binary is built with
  `deno compile`, and the CLI supports Node 22+ and Deno 2.9+ (no longer Bun). Every push to main
  publishes the official image to Docker Hub as `explodi/quaso`, for amd64 and arm64.
- The CLI is published to npm as `@quaso-i18n/cli`, by the release workflow through npm trusted
  publishing; the installed command is still `quaso`.
- The version in the root `package.json` is the only version: the server, the CLI, the image and the
  website all report it.
- The app and the project website share one design system, `@quaso/design-system`: controls,
  typography, icons, theme tokens, fonts and brand assets, so both look and behave alike.
- Upgrade the app and project website to Vite 8 with React Compiler. Enforce the React hooks rules
  against synchronous state changes in effects and rendering through the required checks.

### Fixed

- A Beta 1 database is refused at startup with an explanation, and left unchanged, instead of
  crashing (`no such table: jobs`) or asking to upgrade Quaso.
- Refresh saved settings and editor constraints so switching settings sections shows the latest
  project details, translation instructions, file context and length limits.

### Security

- Require a verified account email for email sign-in links. Password recovery of an unverified
  account verifies the address and removes old OAuth identities as well as replacing its password
  and revoking its sessions.
- Revalidate cookie sessions for private reads, every write and OAuth flows, preventing revoked
  sessions from retaining private access or relinking sign-in methods.
- Update the Cloudflare toolchain's transitive Undici dependency to 7.29.1 to address the ten
  advisories reported by its dependency audit.

## [1.0.0-rc.1] - 2026-10-01

### Added

- i18next JSON v4 parsing and stable rendering, cardinal and ordinal plurals, locked references,
  placeholder checks, language mappings, exclusions and grapheme length limits.
- One-project SQLite service with source uploads, renames, imports, translation history,
  suggestions, review, proofread protection, progress and deterministic downloads.
- Gemini translation jobs with a fake provider for development, configurable prompts and context,
  concurrency, retries, per-language instructions, usage records and monthly budgets.
- Email/password accounts, one-time administrator setup, GitHub and Discord sign-in, optional email
  delivery, volunteer requests, invitations, language-scoped roles and API keys.
- React translation dashboard and editor with plural inputs, live checks, conflict handling,
  keyboard navigation, accessible state indicators, and light/dark themes.
- Review queue, team and account management, settings, jobs, usage and administration pages.
- A Node and Deno CLI for initialization, upload, translation, download, status gates and imports.
  Source files are protected and unapproved suggestions never appear in downloads.
- Docker Compose with Caddy HTTPS, a non-root compiled server image, local data locking, automatic
  and pre-migration snapshots, health checks and structured logs.
- Optional Cloudflare Worker, Containers and SQLite Durable Object storage with edge caching,
  persisted alarms, nightly R2 backups and point-in-time recovery.
- Portable SQLite/JSON backup downloads and restores into empty local or Cloudflare instances.
- Offline unit and integration tests, Astral browser tests, workerd parity tests, CLI runtime checks
  and container smoke checks.
- Deployment, adoption, migration and contributor guides, an i18next example with CI workflows, a
  static documentation website, configuration drift checks and a scripted release process.

### Security

- Service-level permissions, API-key scopes, hashed tokens, password hashing, Origin checks, rate
  limits, content security headers and HTTPS-only remote storage connections.

## [1.0.0] - unreleased

<!-- The team dates and tags the final release after candidate testing. -->
