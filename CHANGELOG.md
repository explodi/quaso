# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.
Release candidates are for deployment and migration testing. The team decides when to tag 1.0.0.

## [Unreleased]

### Added

- Personal API keys: everyone signed in creates, copies once and revokes their own keys on their
  account page (Account → API keys), which says which CLI commands their role allows.
  Administrators still see and revoke everyone's keys in Settings, now with who created each.

- On Cloudflare, the Worker serves the website itself, so it is on screen at once while the
  container sleeps. Opening it starts the container, and the website shows "Waking up Quaso…" with
  a progress bar, based on how long the last start took, until the server answers; a tab that
  comes back after the container fell asleep shows the same above the page. `/wake` says whether
  the server is ready.
- The CLI waits for a sleeping instance before its first request, and says how far along the start
  is, instead of timing out.

- Every push to main publishes its CLI to npm under the tag `main`, as
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
- `quaso import --allow-qa-errors` (`allowQaErrors` in `POST /imports`) imports values that fail
  the quality checks with their QA errors, listed as `flagged`, instead of refusing them, so a
  migration keeps every existing translation.
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

- Auto-translate and `quaso translate` give outdated proofread translations a proposal whenever
  their scope includes outdated work, whatever the upload setting "Propose updates for outdated
  proofread translations" says. The two outdated settings apply to uploads only.

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

### Fixed

- In Safari, the links in the header's menus (Team, Settings, Account and the others) work: the
  menu closed before the click reached them, because Safari doesn't focus a clicked link.

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
