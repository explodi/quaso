# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.
Release candidates are for deployment and migration testing. The team decides when to tag 1.0.0.

## [Unreleased]

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
- Upgrade the app and project website to Vite 8 with React Compiler. Enforce the React hooks rules
  against synchronous state changes in effects and rendering through the required checks.

### Fixed

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
