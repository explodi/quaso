# Set up a development environment

Use this guide to run Quaso from source, find the code for a change, and prepare a pull request.
For translation work on an existing instance, use the [website guide](../website.md).

## Getting started

Install [Deno](https://deno.com/) at the version recorded in `.dvmrc` and Git.
Browser tests also need Node.js to install Chromium; Docker and Cloudflare tools are needed only
for the checks described in [testing](testing.md).

The Deno version in `.dvmrc` is also the `denoland/deno` image tag in `deploy/Dockerfile` and the
Cloudflare and Docker test scripts (`git grep denoland/deno:`), where images are pinned by digest.
When you change the version, update each tag together with the digest that
`docker buildx imagetools inspect denoland/deno:<tag>` prints first (the multi-platform index).

```sh
git clone https://github.com/explodi/quaso.git
cd quaso
deno install --frozen-lockfile
deno task dev
```

`deno task dev` creates `.quaso/` (ignored by Git), fills a SQLite database with sample data, and
starts the app on port 5173 and API server on port 8000. Open the printed address ending in
`/auth/dev-login` to sign in as the development administrator. The app uses a fake translator until
you save a Gemini key in **Settings → AI translation**.

Keep that terminal open. In a second terminal at the repository root, check the running project
and run the normal tests:

```sh
deno task cli status
deno task test
```

The status command lists the sample project's language progress. The CLI uses `.quaso/dev-api-key`
unless you set `QUASO_API_KEY`. Once dependencies are cached, the normal tests use local data and
need no provider key.

To start again, stop the server and run `deno task dev:reset`. This deletes `.quaso/`, including its
accounts and translations, then creates new sample data.

If ports 5173 or 8000 are in use, choose other ports before starting development:

```sh
QUASO_WEB_PORT=5390 QUASO_SERVER_PORT=8123 deno task dev
```

The development CLI still defaults to port 8000. For this example, point it at the changed API port:

```sh
QUASO_HOSTNAME=http://localhost:8123 deno task cli status
```

The development seed and root CLI use a stable, partly translated
[fixture](../../packages/server/src/testing/fixtures/translation-project/README.md). For a playable game
that starts with untranslated English and German targets, follow
[Quaso Quest's setup](../../examples/demo-game/README.md), which runs its own Docker instance.

## Front-end toolchain

The app and project website use Vite 8 and React Compiler through the React plugin's Babel preset.
Their `package.json` files record the versions.
Keep the application and project website on the same Vite toolchain. `deno task lint:react` runs
ESLint's `react-hooks/set-state-in-effect` and `react-hooks/set-state-in-render` as errors.
The full `deno task lint`, included in `deno task check`, enforces the same rules. Derive values during rendering. Change state in event handlers or subscriptions to external data.
Do not suppress these rules to copy props into local state.

## Tasks

| Task                                       | Does                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `deno task dev`                            | Starts the development server and reloads changed code                                        |
| `deno task test`                           | Tests in the packages, scripts, and site; excludes browser, acceptance, and Cloudflare suites |
| `deno task check`                          | Formatting, lint, types, headers, portability, licenses, and the normal tests                 |
| `deno task build`                          | Builds the translation app and compiles the server into `dist/quaso`                          |
| `deno task docker`                         | Builds the Docker image                                                                       |
| `deno task e2e`                            | Runs Puppeteer tests against the real server and built website                                |
| `deno task site`                           | The project landing page, with updates as you edit                                            |
| `deno task site:preview`                   | Builds and serves the project website, including documentation                                |
| `deno task cli …`                          | Runs the `quaso` CLI from source                                                              |
| `deno task cf:dev`, `cf:test`, `cf:deploy` | Cloudflare development, tests, and deployment; requirements vary by task                      |

## Where things live

| Folder                   | Contents                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`          | i18next JSON and whole-file Markdown, plural rules, placeholders, file output, quality checks, schema definitions, and API types. TypeScript without file or network access.                                                                                      |
| `packages/service`       | Uploads, downloads, review, accounts, permissions, and translation, meaning, terminology, and style-guide jobs. Runs in the server on local SQLite or on Cloudflare D1 and R2. Its main logic uses standard web APIs and its ports (`Sql`, `Store`, `Scheduler`). |
| `packages/server`        | The Deno application: HTTP routes, sign-in, local storage, the website's files                                                                                                                                                                                    |
| `packages/design-system` | Shared React controls, themes, fonts, icons, and brand assets for the app and public site                                                                                                                                                                         |
| `packages/web`           | The React application and design-system catalog, built with Vite                                                                                                                                                                                                  |
| `packages/cli`           | The `quaso` command, for Node ≥ 22 and Deno ≥ 2.9                                                                                                                                                                                                                 |
| `packages/cloudflare`    | The Worker, the container controller, `wrangler.jsonc` and the `cf:*` scripts                                                                                                                                                                                     |
| `deploy/`                | The Dockerfile, `compose.yaml`, `Caddyfile` and `.env.example`                                                                                                                                                                                                    |
| `examples/`              | A small i18next app with `quaso.config.json` and CI workflows                                                                                                                                                                                                     |
| `docs/`                  | Documentation for users, operators and contributors                                                                                                                                                                                                               |
| `site/`                  | The project's public website                                                                                                                                                                                                                                      |

[Architecture](architecture.md) explains how the parts fit
together. The [design-system guide](design-system.md) covers shared UI conventions
and package boundaries.

## Conventions

Follow these rules when changing the code:

- **Tests** sit next to the code (`foo.test.ts`) and run with `deno test -A`. Most service tests use an in-memory SQLite database and the fake translator. See
  [testing](testing.md) for suites that need a browser, container, or provider.
- **License headers.** Start code files with an SPDX license header, using the file type's comment syntax, such as
  `// SPDX-License-Identifier: MIT` for TypeScript. CI checks it.
- **Portability.** `core` and `service` must not use `Deno.*` or import `node:`, `jsr:`, `npm:` or
  `@std/` modules outside their tests (CI checks it), because they also run in browsers and in
  `workerd`.
- **SQL** in the service goes through the `Sql` port. Use revision-checked `read()` and `commit()` batches; do not put `BEGIN`, `COMMIT`, or PRAGMAs in
  application statements. Bind at most 100 parameters per statement. Older synchronous helpers
  use the separate `SyncSql` interface and its `transaction()` method.
- **Migrations** only go forward. Add one file in `packages/service/src/migrations/`, register it in
  `MIGRATIONS`, and never edit a released migration. Follow the steps below.
- **Dependencies.** A new dependency needs a reason in the pull request that adds it: what it saves,
  and why stock Deno or a small module of our own won't do. Only permissive licenses (MIT, BSD, ISC,
  Apache-2.0); CI checks them.
- **Commits and pull requests.** Small and focused. Reference the issue, and describe what changed
  and how you tested it. `deno task check` must pass.

## Adding a migration

When the database schema changes, follow these steps:

1. Add `packages/service/src/migrations/NNN_description.ts`, with its SPDX header and an exported
   `Migration` value containing the next version, a short name and SQL. Use the previous migration
   as the format example. Do not edit a released migration or renumber existing ones.
2. Import it in `packages/service/src/migrations.ts` and append it to `MIGRATIONS` in version order.
   `DATABASE_VERSION` follows that array. Keep SQL portable: the adapter supplies transactions;
   D1 does not accept `BEGIN`, `COMMIT`, `SAVEPOINT` or arbitrary PRAGMAs.
3. Write a migration test with representative data from the previous schema. Assert preservation of
   translations, history, roles and settings, and verify the new behavior. Tests must also cover
   upgrading older supported schemas, rather than only creating an empty latest database.
4. Generate the Cloudflare scenario again with `deno task cf:fixtures`, review its diff, then run
   `deno task cf:fixtures --check` and `deno task cf:test` to exercise the same SQL in workerd.
5. Run `deno task check`. Document operator-visible changes in `CHANGELOG.md` and any necessary
   backup, upgrade or rollback steps. Before release, test with a copy of a real database.

## Writing tests and pull requests

See [testing](testing.md) for the test layers and optional external tests. Prefer
assertions about behavior readers can observe, especially permissions and preservation of source files and
proofread translations. Keep tests independent and use the fake translator instead of network calls.
Add a regression test when fixing a bug that could silently lose or expose data.

Commits should describe one focused change. A pull request explains the problem, resulting
behavior, validation, and any migration or deployment effect. Include screenshots for visible UI
changes and explain each new dependency. Run `deno task check` before requesting review. Also run browser or Cloudflare checks when those paths change, and
`deno task site:build` when documentation changes. The [release guide](../releasing.md) covers
versioning.

## Branch protection

CI runs `deno task check` for pull requests and pushes to `main` or `master`. To make a failing check block merging,
turn on branch protection for `main` in the repository settings and require the `deno task check`
status check.

## Code of conduct

Everyone taking part follows our [code of conduct](../../CODE_OF_CONDUCT.md).
