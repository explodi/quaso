# Working on the Cloudflare package

Develop and test the Cloudflare deployment in `packages/cloudflare`, an optional package in the npm
workspace. It uses Wrangler to run the Worker and Vitest to test it in the `workerd` runtime. You
can work on core, the CLI or website without running the Cloudflare tools; use them when your change
affects this deployment.

## The request path

The Worker receives the public request. For paths outside `/api`, `/auth`, `/files`, `/healthz` and
`/schema`, `GET` and `HEAD` normally load the website from the Worker's static assets (the Vite
build, `src/website.ts`) with the server's security headers. `/wake` says whether the server is
ready, and starts it if needed. The website and CLI poll this route to show startup progress.
Anonymous cacheable reads can end at the Worker, and published files (`/files/…`) are served
straight from D1 metadata and R2 bytes without starting the container. Other requests go to the
Quaso container, which runs the same server image as Docker Compose. The server owns the service
logic: accounts, permission checks, translations, LLM jobs and the nightly R2 export. It reaches
storage through two private outbound hosts that the container controller registers:
`d1.quaso.internal` (`src/d1_handler.ts`, SQL batches against the `DB` binding) and
`r2.quaso.internal` (`src/r2_handler.ts`, objects in the `BACKUPS` bucket). The public Worker
returns 404 for the private API paths.

`QuasoContainer` (`src/container.ts`) is the container controller, a Durable Object that holds no
project data. It starts the server once for everyone who waits (`/wake` and requests alike), and
remembers how long the last start took for the progress bar. Before letting the container sleep it
asks the server's `/healthz` whether it is `busy` and when its `nextWakeUp` is, and schedules a
wake-up for it: LLM jobs and the nightly export depend on that, so preserve both when changing
scheduling. Enter the Gemini key in **Settings**; D1 stores it with the other project settings. The
container keeps no lasting project data on its disk.

The controller also stores the Worker deployment ID when it starts the server. After a deployment,
it stops an older server on a request with no other requests in progress, but only if `/healthz`
reports `busy: false`. It waits for the stop before starting with the deployed image and settings.
Keep this check when changing startup: continuous use must not leave the old server running
indefinitely, and a restart must not cut off an LLM job or export.

## Run locally

From the repository root, with Docker running:

```sh
npm ci
cp packages/cloudflare/.dev.vars.example packages/cloudflare/.dev.vars
```

Set `SECRET_KEY` to the output of `openssl rand -hex 32`. Also uncomment `SETUP_KEY` and set it to
the output of `openssl rand -hex 16`; the server needs it to allow first setup. Enter a Gemini key
in **Settings** after setup if you want real translation. Then run:

```sh
npm run cf:dev
```

Open <http://localhost:8787/setup> and create the first administrator with your setup key. Wrangler
builds the container from `deploy/Dockerfile`; the build time depends on the host and image cache.
D1 and R2 are Wrangler's local simulations, kept in its ignored state directory. D1 Time Travel
needs a deployed database and is unavailable locally.

The top level of `wrangler.jsonc` is for local work. The deployment tasks select a named
environment: `cf:setup` and `cf:deploy` generate a temporary configuration from the `staging` or
`production` template and the operator's `quaso.cloudflare.jsonc` (`scripts/instance_config.ts`),
`cf:deploy` requires `--env`; `cf:setup` asks for the environment if it is missing. See
[deployment](../deploy-cloudflare.md) for accounts, domains and secrets.

## Types, fixtures and tests

```sh
npm run cf:types
npm run cf:fixtures
npm run cf:check
```

After changing `wrangler.jsonc`, commit regenerated `worker-configuration.d.ts`. After changing
shared behavior, review and commit the fixture from `packages/cloudflare/scripts/fixtures.ts`.
`cf:check` checks both generated outputs, compiles the package, runs its tests in workerd, and
bundles the Worker without deploying it. Tests compare the same service scenario with local SQLite.

Keep service and core portable: no runtime-specific imports, such as `node:`, in their production code. Worker
modules may export only supported handlers and classes. The D1 adapter
(`packages/service/src/adapters/d1_sql.ts`) sends each commit as one batch, guarded by the database
revision. Use the asynchronous `Sql.read`, `Sql.commit` and `Sql.migrate` methods and the retry
helper in `packages/service/src/write.ts`. The older `SyncSql.transaction` API is for local
synchronous callers; it is not the D1 write path.

## Rollout compatibility

A Worker becomes active before all containers update. The private D1 and R2 handlers must accept the
previous server release during this overlap, and read retries must remain safe. Retry a failed write
only when the write protocol proves that doing so is safe. Schema migrations run when the server
starts. Test restored and upgraded databases as well as brand-new ones. See
[operations](../operations.md) for recovery.
