# Testing

The normal test suite uses local data and a fake translator. Once Bun has cached dependencies, it
needs no accounts, provider keys or Docker. Start with `bun run check` from the repository root.

| Layer                                                     | Command                                | What it checks                                                                                                               |
| --------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Core, service, server, CLI, web helpers and build scripts | `bun run test`                         | JSON round trips, plurals, QA, transactions, state rules, permissions, routes, CLI safety and pure UI logic                  |
| Full local checks                                         | `bun run check`                        | Formatting, ESLint, React state-rule lint, types, SPDX headers, dependency licenses, runtime portability and the tests above |
| Browser                                                   | `bun run e2e`                          | Built React app, actual HTTP server and service, CSP, keyboard flow, forms and visible behavior                              |
| Cloudflare                                                | `bun run cf:check`                     | Generated bindings, fixture, TypeScript, workerd tests and production Worker bundle                                          |
| Container                                                 | `bun run docker:smoke`                 | Build the actual image, start it, upload, restart and verify persistence                                                     |
| Project website                                           | `bun run site:build`                   | Render all documentation and reject broken internal links                                                                    |
| Configuration docs                                        | `bun run scripts/check_config_docs.ts` | Every server variable appears in the environment template and reference                                                      |

Tests sit next to their code as `*.test.ts`. To focus a change:

```sh
bun test packages/service/src/settings_api.test.ts
bun test packages/server/src/storage/backup_files.test.ts
bun test site/build.test.ts
```

## The fake translator

The [Beta 2 workflow fixture](../../acceptance/fixtures/workflow/README.md) contains five
source files, ten languages, nested paths and separate approved/full Crowdin exports.
`bun test acceptance/workflow_fixture.test.ts` checks its import counts, upload changes,
queue order and Crowdin conversion. Its expected data is for the shared URL-driven
workflow test; passing this fixture check does not prove Docker or Cloudflare execution.

`bun test e2e/workflow.test.ts --timeout 180000` runs the full nine-step workflow against
a disposable local instance, using the built CLI, public HTTP and Chromium. The harness
captures the LLM stub's requests and checks proofread Spanish references in every prompt.
Build the CLI first with `bun run build:cli`.

For a dedicated empty instance with a deterministic LLM stub, run
`bun run workflow --url http://127.0.0.1:8000`. A fresh instance needs
`QUASO_SETUP_KEY`; an already claimed empty instance needs `QUASO_ADMIN_EMAIL` and
`QUASO_ADMIN_PASSWORD`. The runner refuses an instance containing active source files.
It revokes its API key and removes its browser page and temporary CLI workspace; the caller must tear
down the disposable instance and its storage, which retain the fixture's account/data.
This command does not configure an LLM stub or run CI. Deployment-specific harnesses must
also capture/check the provider prompts and supply the normal job/publication scheduler.

`packages/service/src/llm/fake.ts` implements the translator port. It preserves placeholders and
plural structure and gives deterministic results. Tests can model delays, failed checks and provider
errors without real calls. Use it to verify retries, cancellation, budgets and races between an LLM
response and a human approval. An LLM result must recheck the source and translation revision after
awaiting the provider; no test should depend on an actual model's prose.

## Browser tests

[e2e/\_setup.ts](../../e2e/_setup.ts) starts an in-process server with in-memory SQLite and the real
security headers. It builds the website when stale. Install Chromium once with `bun run puppeteer browsers install chrome`; Puppeteer starts it for each test. Tests collect console errors, failed requests and CSP violations. Use real routes
where possible; intercept only behavior that is hard to cause deterministically. Browser tests are
separate from the fast unit suite because they start a browser and may need an initial download.

Screenshots in the project website should come from the demo project in this same UI, in light and
dark themes. Regenerate them with `bun run site/screenshots.ts`; it uses disposable in-memory
storage and a real signed-in demo account. Optimize the resulting PNGs without changing their
content. Visual screenshots supplement assertions; they do not replace keyboard or permission tests.
A human VoiceOver/NVDA pass is still part of release review.

## Cloudflare and upgrade fixtures

The optional Cloudflare package runs Vitest in workerd through Bun. Docker is needed for `cf:dev`,
not `cf:test`. Read [Cloudflare development](cloudflare.md) before changing adapters or alarms.

`bun run cf:fixtures` generates the local-service scenario consumed by workerd tests. Commit its
diff alongside a behavior or schema change. `bun run cf:fixtures --check` fails when it is stale.
For historical schema fixtures, preserve already released inputs unchanged: add the next version's
fixture and expected upgrade behavior. Validate actual rows and exported files after migration,
including history, roles and blue translations, and test a newer schema is rejected by an old
reader. The migration steps are in [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-migration).

## Keep a database from every supported release

`packages/service/testdata/upgrade/` preserves databases created with historical implementations:
schema 1 at commit `a290bab` and schema 3 at `c855ab9`. Schema 2 was introduced alongside schema 3
and never shipped separately. These are original databases, not today's migrations run backwards.
`provenance.json` records their origins; each `vN-export.json` and `vN-status.json` records that
version's responses. Run the upgrade check directly with:

```sh
bun test packages/service/src/upgrade.test.ts
```

For each future supported schema:

1. Create a detached worktree at the release tag, for example
   `git worktree add --detach /tmp/quaso-previous v1.0.0`. Use a fresh scratch path and the actual
   tag.
2. Run that checkout's `seed-dev` command or `bun run dev:reset` to create its demo database.
   Upload a changed source file and import translations so history, uploads and activity contain
   data. Add representative roles, suggestions and jobs when that schema supports them. Fixtures
   must contain synthetic data, never real account details or provider keys.
3. Save that running version's `/api/v1/export` and `/api/v1/status` responses using its development
   API key. Stop the server cleanly, then copy `quaso.sqlite` to
   `packages/service/testdata/upgrade/vN.sqlite`. Store its responses as `vN-export.json` and
   `vN-status.json`, and record the source commit and scenario.
4. Extend `upgrade.test.ts` to copy the fixture to temporary storage, migrate it with the current
   service, compare surviving rows, export bytes and status, then exercise an upload, a fake LLM job
   and a reviewed translation. Keep existing fixture files unchanged.
5. Remove the worktree with `git worktree remove /tmp/quaso-previous` after retaining the artifacts,
   and run both the upgrade test and `bun run cf:check`. Review binary fixtures and their
   provenance together in the pull request.

## Acceptance against a running instance

The `acceptance/` suite is separate from `bun run test`. It exercises the public HTTP API, the
bundled CLI and Puppeteer against any reachable instance. Use a disposable development instance or
staging: the suite creates uniquely named source files, translations and accounts. It revokes its
API key and deletes temporary local files; synthetic source/history records remain on the instance.
Never point it at production.

Build the CLI first. Against a running `bun run dev` instance, the development login is enough:

```sh
bun run build:cli
bun run acceptance --url http://localhost:8000
```

Against a claimed staging instance, set `QUASO_ADMIN_EMAIL` and `QUASO_ADMIN_PASSWORD` as
environment secrets. For first setup, also set `QUASO_SETUP_KEY` from the deployment configuration. The suite
uses configured administrator credentials during setup, so later runs can sign in to the same
account. Tokens may also be passed with `--setup-token`, but environment secrets avoid putting them
on command lines.

To check the production image with local storage, use a distinct disposable Compose project:

```sh
export COMPOSE_FILE="$PWD/deploy/compose.yaml:$PWD/deploy/compose.acceptance.yaml"
export COMPOSE_PROJECT_NAME=quaso-acceptance-local
export QUASO_ACCEPTANCE_PORT=8134
docker compose build quaso
docker compose up -d --wait --wait-timeout 120 quaso
docker compose logs quaso
```

Copy the setup key from that disposable instance's deployment configuration, then run:

```sh
export QUASO_SETUP_KEY='the key from the disposable instance'
bun run acceptance --url http://127.0.0.1:8134 --compose-dir deploy
docker compose down -v --remove-orphans
```

Keep `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` exported: the suite's restart command must use the
same stack. The override resets the operator `.env`, binds the port to loopback, and disables Caddy,
development login and Gemini. Test 1 reports a skip without `--compose-dir`; test 3 reports a skip
without an enabled translator. Human-check challenges may skip automated volunteer scenarios; use
the independent browser fixture tests for those controls. The production Compose case intentionally
has no fake-provider override. The development instance exercises the fake translator instead.

`.github/workflows/acceptance.yml` runs the disposable Compose case on main, nightly and manually.
Optional staging jobs activate only when the following configuration is present:

| Configuration                                                      | Purpose                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Variable `STAGING_URL`                                             | Public HTTPS staging origin                                               |
| Secrets `CLOUDFLARE_API_TOKEN`, optionally `CLOUDFLARE_ACCOUNT_ID` | Deploy the preconfigured staging Worker                                   |
| Secrets `STAGING_ADMIN_EMAIL`, `STAGING_ADMIN_PASSWORD`            | Dedicated administrator account for repeated acceptance runs              |
| Secret `STAGING_SETUP_KEY`                                       | Initial claim only; must match the staging instance's setup key         |
| Secrets `STAGING_SERVICE_TOKEN`, `STAGING_SECRET_KEY`              | Also enable a Docker server using that Durable Object's storage           |
| Secret `STAGING_READ_API_KEY`                                      | Enable nightly authenticated response measurements with a read-scoped key |

Configure the staging hostname, bucket and Worker secrets using the deployment guide before enabling
those jobs. The preflight exposes only enabled/disabled flags; it does not print secret values. The
mixed setup runs after Cloudflare staging, using the same data and administrator credentials.

`.github/workflows/nightly.yml` runs the large local stress case and workerd tests without
credentials. The Durable Object performance case uses 3,000 strings in ten languages, with 30,000
translations and 100 exported files; upload, export and browsing operations each have a 30-second
budget. With the read key the workflow saves request timings as an artifact. Its manual
**cold_starts** option adds `--cold-starts 3 --sleep 660`: three measurements, each after an
eleven-minute idle period. Keep the container's sleep timeout below that interval. Acceptance and
nightly workflows share a concurrency group so their own staging requests do not overlap; other
users or uptime probes can still prevent sleep. The workflows do not claim to measure multiple
geographic regions.

## Optional external and large tests

```sh
QUASO_SMOKE=1 bun run test
bun run test:llm
```

The first enables the 50,000-string / 30-language local stress case. The second needs
`GEMINI_API_KEY`, makes real provider requests and may incur usage charges; it evaluates the sample
corpus and writes results for review. Never make either a requirement for a small unrelated patch. A
fake-provider timing result is not evidence of linguistic quality. Real staging deployments,
regional latency, cold starts, PITR and native-speaker evaluation remain separate release checks.

## Beta 2 workflow on the production image

Run `bun run docker:smoke` to build and check the image, then `bun run docker:workflow` for
all nine workflow steps through the compiled server, real browser and CLI. To test another
local image, run `bun scripts/docker_workflow.ts IMAGE` after `bun run build:cli`.

The runner starts disposable containers on a dedicated Docker network. A TLS fixture owns
`generativelanguage.googleapis.com` on that network; the app trusts its temporary certificate
and uses a synthetic key saved through Settings. External DNS is disabled for the app. The
fixture checks that every translation prompt includes proofread Spanish. Application code and
the production image have no test-provider switch. Containers, network, certificates and data
are removed on success or failure. The Acceptance workflow runs this check, and release
publication depends on the same check passing. Real Cloudflare execution remains separate.
