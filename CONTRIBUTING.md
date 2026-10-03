# Contributing to Quaso

Thank you for helping. Quaso aims to be easy to develop, deploy, contribute to, test, adopt and
fork, and every change should keep it that way.

## Getting started

You need [Bun](https://bun.sh/) (the version in `.bun-version`) and git. Nothing else.

```sh
git clone 'https://github.com/<org>/quaso.git'
cd quaso
bun install --frozen-lockfile
bun run dev      # a working Quaso at http://localhost:5173, with a demo project
bun run test     # every test that matters, in seconds, offline
```

`bun run dev` creates `.quaso/` (git-ignored) with a SQLite database and a generated secret key,
seeds a demo project, signs you in as a developer, and uses a fake translator unless
`GEMINI_API_KEY` is set. It prints a development API key for the CLI:

```sh
bun run cli status
```

`bun run dev:reset` wipes `.quaso/` and seeds again.

## Front-end toolchain

Both React packages use Vite 8.3.2 and React Compiler 1.0 through the React plugin's Babel preset.
Keep the application and project website on the same Vite toolchain. `bun run lint:react` runs
ESLint's `react-hooks/set-state-in-effect` and `react-hooks/set-state-in-render` as errors, and is
part of `bun run check`. Derive values during rendering and perform state changes in event
handlers or external-store subscriptions; do not suppress these rules to mirror props into local
state.

## Tasks

| Task                                     | Does                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `bun run dev`                            | the development server, with hot reloading                               |
| `bun run test`                           | every test except the Cloudflare and browser ones                        |
| `bun run check`                          | formatting, lint, type checks, headers, licences and tests: what CI runs |
| `bun run build`                          | builds the website and compiles the server into `dist/quaso`             |
| `bun run docker`                         | builds the Docker image                                                  |
| `bun run e2e`                            | Puppeteer tests against the real server and built website                |
| `bun run site`                           | the project website, with hot reloading                                  |
| `bun run cli …`                          | the `quaso` CLI, from source                                             |
| `bun run cf:dev`, `cf:test`, `cf:deploy` | Cloudflare storage and containers (optional; needs Wrangler through npm) |

## Where things live

| Folder                | Contents                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | i18next files and quality: JSON reader and writer, plural rules, tokenizer, renderer, checks, the schema module and the API types. Pure TypeScript, no I/O.                                   |
| `packages/service`    | the service: upload, download, review, accounts, permissions, LLM jobs. Runs in Bun and in a Cloudflare Durable Object, so it only uses web-standard APIs and its ports (`Sql`, `Scheduler`). |
| `packages/server`     | the Bun application: HTTP routes, sign-in, local storage, the website's files                                                                                                                 |
| `packages/web`        | the React website, built with Vite                                                                                                                                                            |
| `packages/cli`        | the `quaso` command, for Node ≥ 22 and Bun ≥ 1.4.2                                                                                                                                            |
| `packages/cloudflare` | optional: the Durable Object, the Worker and `wrangler.jsonc`                                                                                                                                 |
| `deploy/`             | the Dockerfile, `compose.yaml`, `Caddyfile` and `.env.example`                                                                                                                                |
| `examples/`           | a small i18next app with `quaso.config.json` and CI workflows                                                                                                                                 |
| `docs/`               | documentation for users, operators and contributors                                                                                                                                           |
| `site/`               | the project's public website                                                                                                                                                                  |

[docs/contributing/architecture.md](docs/contributing/architecture.md) explains how the parts fit
together.

## Conventions

- **Tests** sit next to the code (`foo.test.ts`) and run with `bun test`. They are fast and
  offline: an in-memory SQLite database and the fake translator.
- **Licence headers.** Every code file starts with `// SPDX-License-Identifier: MIT` (CI checks it).
- **Portability.** `core` and `service` must not use `Bun.*` or import `node:`, `jsr:`, `npm:` or
  `@std/` modules outside their tests (CI checks it), because they also run in browsers and in
  `workerd`.
- **SQL** in the service goes through the `Sql` port: no `BEGIN` or `COMMIT` (use `transaction()`),
  no PRAGMAs, at most 100 bound parameters per statement.
- **Migrations** only go forward. Add one file in `packages/service/src/migrations/`, register it in
  `MIGRATIONS`, and never edit a released migration. Follow the steps below.
- **Dependencies.** A new dependency needs a reason in the pull request that adds it: what it saves,
  and why stock Bun or a small module of our own won't do. Only permissive licences (MIT, BSD, ISC,
  Apache-2.0); CI checks them.
- **Commits and pull requests.** Small and focused. Reference the issue, and describe what changed
  and how you tested it. `bun run check` must pass.

## Adding a migration

1. Add `packages/service/src/migrations/NNN_description.ts`, with its SPDX header and an exported
   `Migration` value containing the next version, a short name and SQL. Use the previous migration
   as the format example. Do not edit a released migration or renumber existing ones.
2. Import it in `packages/service/src/migrations.ts` and append it to `MIGRATIONS` in version order.
   `DATABASE_VERSION` follows that array. Keep SQL portable: the adapter supplies transactions;
   Durable Object SQLite does not accept `BEGIN`, `COMMIT`, `SAVEPOINT` or arbitrary PRAGMAs.
3. Write a migration test with representative data from the previous schema. Assert preservation of
   translations, history, roles and settings, and verify the new behavior. Tests must also cover
   upgrading older supported schemas, rather than only creating an empty latest database.
4. Regenerate the Cloudflare scenario with `bun run cf:fixtures`, review its diff, then run
   `bun run cf:fixtures --check` and `bun run cf:test` to exercise the same SQL in workerd.
5. Run `bun run check`. Document operator-visible changes in `CHANGELOG.md` and any necessary
   backup, upgrade or rollback steps. Before release, rehearse with a copy of a real database.

## Writing tests and pull requests

See [testing](docs/contributing/testing.md) for the test layers and optional external tests. Prefer
assertions about observable behavior, especially permissions and preservation of source files and
proofread translations. Keep tests independent and use the fake translator instead of network calls.
Add a regression test when fixing a bug that could silently lose or expose data.

Commits should describe one coherent change. A pull request explains the problem, resulting
behavior, validation, and any migration or deployment effect. Include screenshots for visible UI
changes and explain each new dependency. Run `bun run check` before requesting review; run the
browser or Cloudflare checks when those paths change. The [release guide](docs/releasing.md) covers
versioning.

## Branch protection

CI runs `bun run check` on every push and pull request. To make a failing check block merging,
turn on branch protection for `main` in the repository settings and require the `bun run check`
status check.

## Code of conduct

Everyone taking part follows our [code of conduct](CODE_OF_CONDUCT.md).
