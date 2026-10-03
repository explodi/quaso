# Architecture

This page explains how Quaso is built, for people who want to change it. For how to set up a
development environment, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## One application, one database, one game

Quaso is one Bun application for one game. It serves a static website and an HTTP API (`/api/v1`),
and keeps all its data in one SQLite database. A deployment serves one game, for example at
`translate.yourgame.com`; a studio with several games runs one deployment per game.

```text
 CLI (Node or Bun)            Browsers
       │  API key                 │  session cookie
       ▼                          ▼
┌──────────────────────────────────────────────┐
│ server (Bun): website files + HTTP API      │
└──────────────────────┬───────────────────────┘
                       │ direct call, or HTTPS to a Worker
                       ▼
┌──────────────────────────────────────────────┐
│ service: the logic and the data, in SQLite   │
│  local storage: a SQLite file                │
│  Cloudflare storage: a Durable Object        │
└──────────────────────┬───────────────────────┘
                       ▼
                   Gemini API
```

- **The website** (`packages/web`) is a static React app. It only talks to the HTTP API, so anything
  it does can also be scripted.
- **The server** (`packages/server`) serves the website's files and the API. It authenticates people
  and API keys, validates requests, and calls the service.
- **The service** (`packages/service`) holds the logic and the data: files, strings, translations,
  suggestions, history, LLM jobs, people, roles, sessions and API keys.
- **core** (`packages/core`) is everything about i18next files and quality: parsing, plural rules,
  rendering files, and the quality checks. The service, the website and the CLI all use it, so a
  translation the editor accepts is always one the API accepts.
- **The CLI** (`packages/cli`) talks only to the API. It never runs git.

## Two places for the data

The service runs in one of two places, with exactly the same code:

| Storage         | Where the service runs                                      | The database                                       |
| --------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Local (default) | inside the server                                           | one SQLite file, `quaso.sqlite` in the data folder |
| Cloudflare      | inside one Cloudflare Durable Object, behind a small Worker | the Durable Object's SQLite storage                |

With Cloudflare storage, the server calls the service over HTTPS (`SERVICES_URL`, with
`SERVICE_TOKEN`): one request per operation, with the same inputs and outputs as the direct call.

### Ports

The service never calls a runtime API directly. It uses small interfaces, each with one
implementation per place:

- `Sql` (`packages/service/src/ports.ts`): run a statement, query rows, run a script, and run a
  function as one synchronous transaction. On `node:sqlite` in the server, and on `ctx.storage.sql`
  in the Durable Object.
- `Scheduler`: wake the service up later, for LLM jobs. A timer in the server, whose next wake-up is
  stored in the database, or a Durable Object alarm.

This is why `core` and `service` may only use web-standard APIs: no `Bun.*`, and no `node:`,
`jsr:`, `npm:` or `@std/` imports outside tests. CI checks it.

### One writer at a time

Every operation (an upload, an approval, an LLM result) runs as one synchronous transaction. The
service never waits for anything between reading and writing, so operations can't interleave: the
Bun server is single-threaded, and a Durable Object runs synchronous code one event at a time.
While the service waits for Gemini, it keeps serving other requests.

## The data model

- A **string** is a key in a source-language file, identified by its file and key path, never by its
  text. Plural groups (`coins_one`, `coins_other`) are one string with a form per plural category.
- A **translation** is the current accepted text of one string in one language, with its colour:
  green (from the LLM) or blue (proofread by a person). No translation means red. Downloads read
  only translations.
- A translation is **outdated** when the source text changed after it was made: it remembers the
  hash of the source it was made for.
- **Suggestions** are pending changes from volunteers, and the LLM's proposals for outdated blue
  translations. Downloads never read them.
- **History** records every change, in the same transaction as the change.
- **Uploads delete nothing.** Removed keys and files are hidden, and come back with their
  translations.

Every change to a translation goes through one function in the service, which enforces the rules
(for example, the LLM never overwrites a blue translation), writes history and raises the project's
revision.

## Files

`core` reads JSON with its own order-preserving parser: it keeps key order (even for keys like
`"10"`), rejects duplicate keys, reports line and column, and records the file's indentation and
line endings. The renderer rebuilds each language's file from the source-language structure, in the
same order and format, so downloading twice gives the same bytes and a download with nothing new
produces no git diff.

## Accounts and permissions

Authentication lives at the server boundary, while authorization lives beside the data in the
service. Passwords use salted PBKDF2 with the instance secret mixed in. The service stores hashed
session IDs and API keys; the server signs short-lived session cookies and checks Origin on browser
writes. Roles are none, contributor, manager and administrator, optionally limited to languages.
Invites and volunteer requests grant no rights until the service accepts them. The website's `can()`
helpers control visible actions but never replace service checks.

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
replacement text. Provider keys stay with the service; the browser and CLI never receive them.

Local storage snapshots use SQLite's backup API and run in a worker on a read-only connection.
Pre-migration snapshots are taken before schema changes. Portable JSON exports stream table chunks
and check the database revision, restarting when concurrent changes would mix states. Cloudflare
streams the nightly export to R2. SQLite and JSON restores share the service import path, reject a
used destination and migrate older schemas. They preserve accounts but omit sessions and transient
authentication secrets; password verification still needs the original instance secret.

## Tests

- Tests sit next to the code (`*.test.ts`) and run with `bun run test`: offline, in seconds, with
  an in-memory database and a fake translator.
- The same test cases run against both implementations of each port.
- The Cloudflare package has its own tests, which run in `workerd` (`bun run cf:test`).

See [testing](testing.md) for commands, and [Cloudflare development](cloudflare.md) for its runtime.
