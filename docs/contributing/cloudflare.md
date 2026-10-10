# Working on the Cloudflare package

`packages/cloudflare` is optional and part of the Deno workspace. It owns Wrangler, Cloudflare
Containers bindings and the Vitest workerd pool. Contributors changing core, the CLI or ordinary
website code do not need these tools.

## The request path

The Worker receives the public request. Every read outside the server's paths (`/api`, `/auth`,
`/files`, `/healthz`, `/schema`) is the website, served from the Worker's static assets (the Vite
build, `src/website.ts`) with the server's security headers. `/wake` says whether the server is
ready, and starts it if it isn't: the website and the CLI ask it to show a start's progress
instead of waiting in silence. Anonymous cacheable reads can end at the Worker, and published
files (`/files/…`) are served straight from D1 metadata and R2 bytes without starting the container.
Other requests go to the Quaso container, which runs the same server image as Docker Compose. The
server owns the service logic: accounts, permission checks, translations, LLM jobs and the nightly
R2 export. It reaches storage through two private outbound hosts that the container controller
registers: `d1.quaso.internal` (`src/d1_handler.ts`, SQL batches against the `DB` binding) and
`r2.quaso.internal` (`src/r2_handler.ts`, objects in the `BACKUPS` bucket). The public Worker answers
404 to those paths.

`QuasoContainer` (`src/container.ts`) is the container controller, a Durable Object that holds no
project data. It starts the server once for everyone who waits (`/wake` and requests alike), with
limits long enough for a cold start, and remembers how long the last start took for the progress
bar. Before letting the container sleep it asks the server's `/healthz` whether it is
`busy` and when its `nextWakeUp` is, and schedules a wake-up for it: LLM jobs and the nightly export
depend on that, so preserve both when changing scheduling. The Gemini key is entered in Settings and
kept in D1, like every other setting; the container's disk is ephemeral and holds no project data.

`src/data_object.ts` and `src/nightly_backup.ts` belong to the earlier design, where a `QuasoData`
Durable Object held the database; `wrangler.jsonc` no longer binds it.

## Run locally

From the repository root, with Docker running:

```sh
deno install
cp packages/cloudflare/.dev.vars.example packages/cloudflare/.dev.vars
```

Fill in `SECRET_KEY` with a long random value, for example the output of `openssl rand -hex 32`.
To exercise real translation, enter a Gemini key in Settings after setup. Then:

```sh
deno task cf:dev
```

Open <http://localhost:8787>. Wrangler builds the container from `deploy/Dockerfile`; on another CPU
architecture this may take longer. D1 and R2 are Wrangler's local simulations, kept in its ignored
state directory. D1 Time Travel needs a deployed database and is unavailable locally.

The top level of `wrangler.jsonc` is only for local work. Deployments never use it directly:
`cf:setup` and `cf:deploy` generate a temporary configuration from the `staging` or `production`
template and the operator's `quaso.cloudflare.jsonc` (`scripts/instance_config.ts`), and require
`--env`. See [deployment](../deploy-cloudflare.md) for accounts, domains and secrets.

## Types, fixtures and tests

```sh
deno task cf:types
deno task cf:fixtures
deno task cf:check
```

After changing `wrangler.jsonc`, commit regenerated `worker-configuration.d.ts`. After changing
shared behavior, review and commit the fixture from `packages/cloudflare/scripts/fixtures.ts`.
`cf:check` checks both generated outputs, compiles the package, runs its tests in workerd, and
bundles the Worker without deploying it. Tests compare the same service scenario with local SQLite.

Keep service and core portable: no Deno or Node runtime imports in their production code. Worker
modules may export only supported handlers and classes. D1 does not accept SQL transaction
statements: the D1 adapter (`packages/service/src/adapters/d1_sql.ts`) sends each commit as one
batch, guarded by the database revision. Use the port's transaction API and existing query helpers.

## Rollout compatibility

A Worker becomes active before all containers update. The private D1 and R2 handlers must accept
the previous server release during this overlap, and read retries must remain safe. Never retry
writes blindly. Schema migrations run when the server starts. Test restored and upgraded databases
as well as brand-new ones. See [operations](../operations.md) for recovery.
