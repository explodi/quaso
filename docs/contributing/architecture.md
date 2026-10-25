# Architecture

This page explains how Quaso is built, for people who want to change it. For how to set up a
development environment, see [development setup](README.md).

## One application, one database, one game

Each Quaso instance serves one project with an HTTP API at `/api/v1` and a React website. The
service runs in a Deno server and stores project records in SQLite, either locally or through
Cloudflare D1. Published files and backups use separate object storage. For several games, run one
instance per game.

```text
 CLI (Node or Deno)           Browsers
       │  API key                 │  session cookie
       ▼                          ▼
┌──────────────────────────────────────────────┐
│ server (Deno): website files + HTTP API     │
└──────────────────────┬───────────────────────┘
                       │ direct call
                       ▼
┌──────────────────────────────────────────────┐
│ service: the logic and the data, in SQLite   │
│  local storage: a SQLite file                │
│  Cloudflare storage: D1 + R2 objects         │
└──────────────────────┬───────────────────────┘
                       ▼
                   Gemini API
```

The diagram shows the local request path. On Cloudflare, a Worker serves the website and
published files, caches public API reads, and forwards server requests to the Deno container.
The website can load while the container wakes. See [Cloudflare development](cloudflare.md).

The packages divide the work as follows:

- **The website** (`packages/web`) is a static React app. It only talks to the HTTP API, so anything
  it does can also be scripted.
- **The design system** (`packages/design-system`) supplies shared React base components, themes,
  typography and assets to the app and public project website (`site`). Consumers import
  `@quaso/design-system`; the package does not import the app, its router, or domain types.
  See the [design-system guide](design-system.md) for component and styling conventions.
- **The server** (`packages/server`) serves the website's files and the API. It authenticates people
  and API keys, validates requests, and calls the service.
- **The service** (`packages/service`) holds the logic and the data: files, strings, translations,
  suggestions, history, translation and quality jobs, people, roles, sessions, and API keys.
- **core** (`packages/core`) is source-file parsing, plural rules,
  file output, and quality checks for i18next JSON and whole-file Markdown. The service, the website and the CLI all use it, to keep format and quality rules consistent. The service also checks permissions, current
  settings, and revisions; it can reject a request that passed the editor's local checks.
- **The CLI** (`packages/cli`) talks only to the API. It never runs git.

## Two places for the data

Both deployments run the same service code inside the Deno server. Storage and request handling
differ:

| Storage         | Where the server runs                         | The database                                       | Files and backups |
| --------------- | --------------------------------------------- | -------------------------------------------------- | ----------------- |
| Local (default) | Docker, a VM, or `deno task dev`              | one SQLite file, `quaso.sqlite` in the data folder | the data folder   |
| Cloudflare      | a Cloudflare Container, behind a small Worker | a D1 database                                      | an R2 bucket      |

In the Cloudflare container, the server reaches D1 and R2 through two private outbound hosts,
`d1.quaso.internal` and `r2.quaso.internal`, which the container controller handles with the
Worker's bindings. See [working on the Cloudflare package](cloudflare.md).

### Ports

The service's main logic uses standard web APIs and small interfaces called **ports**. Adapters
implement these ports for each storage mode:

- `Sql` (`packages/service/src/ports.ts`): read statements in one consistent snapshot, commit a
  batch of writes against the revision it read, and apply a migration. On `node:sqlite` with local
  storage, and on D1 in the Cloudflare container.
- `Store`: private objects for published file versions and backups. The data folder with local
  storage, R2 on Cloudflare.
- `Scheduler`: wake the service up later, for LLM jobs and backups. A timer in the server; on
  Cloudflare the container controller also wakes a sleeping container when work is due.

This is why `core` and the main `service` logic use standard web APIs. They do not use `Deno.*` or `node:`,
`jsr:`, `npm:` or `@std/` imports outside tests. CI checks it.

### One writer at a time

Every operation (an upload, an approval, an LLM result) reads the database at one revision, decides
its writes, and commits them as one batch guarded by that revision (`packages/service/src/write.ts`).
Writes through the same `Sql` take turns: each read-decide-commit waits for the one before it
(`withRetries`). The service sends every request's writes through one `Sql`, so a translator's
saves sent together, their LLM suggestions and a running job queue instead of racing. A write
must not start another through the same `Sql`, since it would wait for itself; a commit hook
writes through the `Sql` it wraps. The revision guard catches writers that don't share the `Sql`:
if another commit landed in between, the batch aborts before changing anything, and the operation
reads again and retries; after four tries it answers that the project is busy. Each successful batch is atomic: all its writes commit together. Reads don't
wait for a turn. While the service waits for Gemini, it keeps serving other requests.

### The cache

Some reads cover the whole project, such as its progress (every string and translation), and
the editor asks for them every few seconds. The service keeps their results in memory
(`packages/service/src/cache.ts`), under keys that hold the project revision:
`["progress", 41, model, "es"]`. A request reads only the revision (one row); while it stays the
same, the answer comes from memory. Every write raises the revision, so the next request uses a
new key and the old entry ages out. Nothing is ever invalidated by hand.

That holds only if nothing changes what a key names without raising the revision. Commits raise
it; the contextual-check refresh, which writes outside a commit, raises it in the same batch; a
restore raises it rather than taking the backup's. Anything cached must depend only on data that
changes with the revision, and on what else is in its key.

The cache has a memory budget (32 MB, sizes estimated) and evicts expired entries first, then the
least recently used; every entry has a time to live (five minutes by default), which also bounds
how long a change made outside Quaso, such as editing the database by hand, could go unseen.
Requests for a key while it loads share that one load; a failed load isn't kept; values are
frozen, since every caller shares them.

### Contextual checks

Duplicates (two keys of a file with the same translation but different English) and consistency
(the same English translated differently) compare translations with each other, so they're
stored per translation and refreshed after the commit that changes one
(`packages/service/src/contextual_checks.ts`). A commit that writes strings or files (an upload,
a rename) checks every translation again. One that writes only translations checks again only
what it can affect: the translations of each changed string's file and language, and those with
the same English in that language. A `meta` checkpoint holds the newest history row the stored
checks reflect; every translation change writes history in its commit, so the history after the
checkpoint lists every change since. Without a checkpoint, such as after a restore, which deletes
it, the refresh checks everything.

## The data model

The service keeps these records and states:

- A **string** is a key in a source-language file, identified by its file and key path, never by its
  text. A Markdown document uses one string with an empty key path; the file identifies it. Plural groups (`coins_one`, `coins_other`) are one string with a form per plural category.
- A **translation** is the current accepted text of one string in one language, with its colour:
  green (awaiting review) or blue (marked as proofread). Imports can set either state. No translation means red. Downloads use accepted translations, with source fallback or omission according to export options.
  Pending suggestions never supply exported text.
- A translation is **outdated** when the source text changed after it was made: it remembers the
  hash of the source it was made for.
- **Suggestions** are pending changes from volunteers, and the LLM's proposals for outdated blue
  translations. Downloads never read them.
- **History** records accepted translation changes in the same transaction as each change.
- **Uploads delete nothing.** Removed keys and files are hidden, and come back with their
  translations. Retention rules for old published file versions do not remove these source records.

Every change to a translation goes through one function in the service, which enforces the rules
(for example, the LLM never overwrites a blue translation), writes history and raises the project's
revision.

## Files

`core` reads JSON with a parser that preserves order: it keeps key order (even for keys like
`"10"`), rejects duplicate keys, reports line and column, and records the file's indentation and
line endings. The renderer rebuilds each language's file from the source-language structure, in the
same order and format. Given the same source, translations, and export options, it produces the same bytes. This
keeps repeated downloads from causing changes in Git.

Markdown files use a different path: the entire document is one value. The core removes a byte
order mark, normalizes line endings, and removes final whitespace. Downloads add one final
newline. Quality checks preserve the number of paragraphs, separated by blank lines, rather than
each internal line break. The source parser does not split Markdown into headings or sentences;
`documents.ts` reads only what the checks need: each paragraph's kind of block, the parts kept
verbatim, and heading anchors. An LLM update of a document puts back the paragraphs whose English
didn't change (`keepUntouchedParagraphs`), using the English the translation was made for, from
the string's history.

Repository descriptions can accompany source strings in sidecar files or fields with a configured
suffix. They supply translation context without becoming translatable strings. Stored source
warnings record possible ambiguity; descriptions can resolve a source's needs-context listing.

## Accounts and permissions

Authentication lives at the server boundary, while authorization lives beside the data in the
service. Passwords use PBKDF2-SHA-256 with an independent random salt per password. Changing the instance
signing secret does not change password verification. The service stores hashed
session IDs and API keys; the server signs short-lived session cookies and checks Origin on browser
writes. Roles are none, contributor, manager, and administrator. Contributors and managers can be limited
to selected languages.
A pending volunteer request allows comments but not translation edits. An invite grants its role
and language access when redeemed through an allowed account flow. The website's `can()`
helpers control visible actions but never replace service checks.

Every signed-in user can create, list, and revoke their own API keys. Administrators can manage
all keys. A user-created key requires both an allowed scope and the creator's current permissions;
its language limits follow the creator too. A deleted creator makes it unusable. Keys created by
the server command have no user owner and follow their scope alone.

Session cookies carry a signed one-hour token. The server may trust it without a storage lookup only
for public API reads identified by the route's access declaration. The session response itself,
private reads, writes and OAuth flows always resolve the session through the service, so a revoked
session cannot retain private access or link another identity. Roles are still checked beside the
data on every action. OAuth linking checks the same session again inside the service transaction,
closing the interval while the server exchanges the provider's authorization code.

Email sign-in links require a verified account email. Password reset revokes old sessions and unused
access links. Recovery of an unverified email also removes previously linked OAuth identities and
marks the address verified, preventing someone who registered another person's address from keeping
access after its owner recovers it. Verification alone does not perform account recovery.

A manager's direct edit becomes blue. A contributor's edit stays a suggestion until a manager
approves it. Approval supersedes competing suggestions, and revision checks turn stale edits into
409 conflicts rather than silent overwrites. All accepted translation changes share one write path.

## LLM jobs and backups

LLM jobs persist their scope, progress, request outcomes and next wakeup. The local scheduler uses
timers; Cloudflare uses alarms, shared with nightly backups. Batches call the translator outside a
transaction, then recheck source hashes, translation revisions and blue status before saving.
Quality checks run on every result, and outdated blue strings receive proposals instead of
replacement text. Administrators submit provider keys through Settings. The service stores them and returns only
status and a short ending, not the saved key. Translation requests use the stored key on the server.

Editor LLM drafts use a separate request path. They have the same quality rules and usage
accounting as translation work, but do not write translations or pending suggestions. The browser
caches drafts while the page remains open and requests upcoming strings in small batches. A
separate model setting can serve these drafts without changing the normal job model.

Optional translation memory reuses current accepted values with identical source, kind, and
plural structure in the same language. Copied values are green and record their origin in history;
proofread originals are unchanged. Quality jobs separately compare meaning, propose glossary
terms, and draft language instructions. They store review findings and drafts, not replacement
translations. Their result writes check that source, value, and relevant context are still current.

Local storage snapshots use SQLite's backup API and run in a worker on a read-only connection.
Pre-migration snapshots are taken before schema changes. Portable JSON exports stream table chunks
and check the database revision, restarting when concurrent changes would mix states. Cloudflare
streams the nightly export to R2. SQLite and JSON restores share the service import path, reject a
used destination and migrate older schemas. Restores preserve account password hashes, clear sessions and email tokens, and keep the destination
instance's signing secrets. Both restore formats skip the source instance's provider secrets; enter those again after restore.
Portable JSON backups omit these secrets, but SQLite snapshots contain them and need private storage.

## Tests

Tests sit next to the code as `*.test.ts`. `deno task test` runs the normal local suite using a
fake translator. Shared cases under `packages/service/src/testing/` check storage behavior against
local SQLite and the D1 adapter through the production storage handler. The former Durable
Object storage service has been removed; Durable Objects still control the Cloudflare container. Cloudflare tests run separately in `workerd` with
`deno task cf:test`.

See [testing](testing.md) for commands, and [Cloudflare development](cloudflare.md) for its runtime.
