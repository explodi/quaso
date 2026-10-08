# Working on the Cloudflare package

`packages/cloudflare` is optional and part of the Deno workspace. It owns Wrangler, Cloudflare
Containers bindings and the Vitest workerd pool. Contributors changing core, the CLI or ordinary
website code do not need these tools.

## The request path

The Worker receives the public request. Anonymous cacheable reads can end there. Other requests go
to the Quaso container, which runs the same server image as Docker Compose. The server calls the
Worker's authenticated internal API, which invokes the service in `QuasoData`, a Durable Object with
SQLite storage. `QuasoContainer` is the container controller; it is not the project's database.

The data object runs accounts, permission checks, translations and LLM jobs. `GEMINI_API_KEY`
belongs to the Worker/data object. The container has ephemeral disk and does not hold project data.
One Durable Object alarm serves both persisted LLM wakeups and the nightly R2 export: always
preserve both when changing scheduling. The SQL port uses `ctx.storage.sql` and `transactionSync`.

## Run locally

From the repository root, with Docker running:

```sh
deno install
cp packages/cloudflare/.dev.vars.example packages/cloudflare/.dev.vars
```

Fill in `SECRET_KEY` and `SERVICE_TOKEN` with independent long random values, for example the output
of `openssl rand -hex 32`. Set `GEMINI_API_KEY` only if exercising real translation. Then:

```sh
deno task cf:dev
```

Open <http://localhost:8787>. Wrangler builds the container; on another CPU architecture this may
take longer. Its internal API uses `http://host.docker.internal:8787/internal`, since the host's
localhost is not the container's localhost. Local state is in Wrangler's ignored state directory.
PITR needs a deployed Durable Object and is unavailable locally.

The root Wrangler environment is only for local work. `cf:deploy` requires `--env staging` or
`--env production`. Never use an unqualified deploy to test a local change. See
[deployment](../deploy-cloudflare.md) for accounts, domains and first-deploy secrets.

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
modules may export only supported handlers and classes. Durable Object SQLite binds numbers as REAL
(strict integer columns still enforce integer values), limits LIKE/GLOB patterns and does not accept
SQL transaction statements. Use the port's transaction API and existing query helpers.

## Rollout compatibility

A Worker becomes active before all containers update. The internal transport must accept the
previous server release during this overlap, and read retries must remain safe. Never retry writes
blindly. Schema migrations run on object startup under `blockConcurrencyWhile`. Test restored and
upgraded objects as well as brand-new ones. See [operations](../operations.md) for recovery.
