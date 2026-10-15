# Deploy on Cloudflare

Run Quaso in your Cloudflare account with a Worker, one container, a D1 database and an R2 bucket.
Use this guide if your team manages Cloudflare services. For a server you manage yourself, see
[Docker Compose](deploy-docker.md).

Test a deployment and a restore on staging before sending production traffic to it. See
[operations](operations.md) for a drill checklist and rollback steps.

## What you need

Before you start, check that you have the following:

- A Cloudflare account on the **Workers Paid** plan with Containers enabled, and a domain on
  Cloudflare, such as `yourgame.com`. See
  [Cloudflare Containers](https://developers.cloudflare.com/containers/).
- [Deno](https://deno.com) 2.9.6 and git, to run the commands from the repository. Docker is not
  needed for this deployment: Cloudflare pulls the published image. See
  [Cloudflare image management](https://developers.cloudflare.com/containers/guides/image-management/).

These instructions describe the current `main` branch. The Worker and website come from your
checkout; the server comes from the image built for the same commit. For a tagged release, use the
documentation in that release's checkout. Get the current source and matching image name:

```sh
git clone --branch main 'https://github.com/explodi/quaso.git'
cd quaso
deno install --frozen-lockfile
QUASO_IMAGE="explodi/quaso:sha-$(git rev-parse --short=7 HEAD)"
printf '%s\n' "$QUASO_IMAGE"
```

Wait for that commit's **Docker image** workflow to publish the image before setup. A commit that
has not published an image is not ready for these commands. Do not pair its Worker with an older
server image.

Run every `deno task cf:*` command from the repository root. Replace the example hostname with one
in your account.

## 1. Sign in to Cloudflare

```sh
cd packages/cloudflare
deno run -A npm:wrangler login
cd ../..
```

For automation, Wrangler reads an API token from `CLOUDFLARE_API_TOKEN` (and the account from
`CLOUDFLARE_ACCOUNT_ID`) instead. The token needs these permissions:

- Account: Workers Scripts Edit, Containers Edit, D1 Edit, Workers R2 Storage Edit, Account Settings
  Read.
- Zone, for the domain Quaso runs on: Workers Routes Edit, DNS Edit, Zone Read.
- Optional, to read logs during [troubleshooting](#troubleshooting): Workers Tail Read and Workers
  Observability Read.

## 2. Create the instance

`cf:setup` creates everything an instance needs and deploys it:

```sh
deno task cf:setup --env production --hostname translate.yourgame.com \
  --location weur --image "$QUASO_IMAGE"
```

The image is required for a new instance. Setup asks for the account, environment, hostname and
location when they are not supplied. The options are:

- `--env`: `production` or `staging`. Each environment is a separate instance with its own Worker,
  database, bucket and secrets.
- `--hostname`: the address people will use, in an active domain of the account. The Worker gets it
  as a
  [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):
  Cloudflare creates its DNS record and certificate, so the hostname must not have a DNS record yet.
- `--location`: a preferred region for the new D1 database, R2 bucket and container controller:
  `weur` or `eeur` (Europe), `wnam` or `enam` (North America), `apac` or `oc`. Pass `--location ''`
  for automatic placement. This is a
  [location hint](https://developers.cloudflare.com/d1/configuration/data-location/), not a
  placement guarantee. Changing it later does not move an existing database or bucket.
- `--image`: the release to run, a tag or digest of the published image, such as
  `explodi/quaso:sha-<commit>` or `explodi/quaso@sha256:…`. Use the matching source commit. For a
  release, use its tag and matching image. A digest identifies the exact image contents.
- `--name`: the Worker's name, `quaso-production` or `quaso-staging` by default. The database takes
  the same name and the bucket `<name>-store`.
- `--check`: only check that the account has Container access and list its domains; create nothing.

Setup performs these steps:

1. Checks that the account can run Containers (Workers Paid).
2. Creates the D1 database and the R2 bucket, unless they already exist.
3. Saves the instance settings in `quaso.cloudflare.jsonc` at the repository's root (git ignores
   it).
4. Generates the Worker's secrets, `SECRET_KEY` and `SETUP_KEY`, and prints the setup key once: save
   it.
5. Deploys the Worker with the image as `docker.io/<image>`, which Cloudflare pulls from Docker Hub,
   and waits until `https://<hostname>/healthz` answers.

Keep a copy of `quaso.cloudflare.jsonc` somewhere safe, such as your password manager or the
repository that holds your infrastructure: it names the database by its ID, and every later deploy
reads it. If setup stops part way, run it again with the same options: it picks up where it stopped.

Turn on **Always Use HTTPS** for the zone under **SSL/TLS → Edge Certificates**, so nobody signs in
over plain `http`.

## 3. Create the administrator

Open `https://translate.yourgame.com`, enter the setup key, and create the first administrator
account. Then, in **Settings**:

- **AI translation:** for translation with a large language model (LLM), enter the Gemini API key,
  and choose the model, parallel requests and monthly budget. Without a key, LLM translation is off.
- **API keys:** create one for each integration, such as an `upload` key for continuous integration
  (CI). Create upload keys with an administrator account: a key created in the website has its
  creator's current role and language limits as well as its chosen scope.

Check it from outside:

```sh
curl --fail https://translate.yourgame.com/healthz
```

Expect `ok: true`, `storage: "cloudflare"` and the chosen server version in the JSON response.

Then follow [From your repository to every language](workflow.md) to connect your game, or
[Migrate from Crowdin](migrate-from-crowdin.md) to bring existing translations and their proofread
state.

## How it fits together

Requests follow these paths:

```text
 Browsers, the CLI, games
        │ https://translate.yourgame.com
        ▼
┌─────────────────────────────────┐
│ Worker                          │
│  the website: its own files     │
│  anonymous reads: its cache     │        ┌──────────────────────────────┐
│  /files/…: straight from ───────┼───────►│ D1: the database             │
│    D1 and R2                    │        │ R2: files and nightly backups│
│  everything else: the container │        └──────────────▲───────────────┘
└───────┬─────────────────────────┘                       │
        ▼                                                 │ private bindings
┌─────────────────────────────────┐                       │ (d1.quaso.internal,
│ Container: the Quaso server     ├───────────────────────┘  r2.quaso.internal)
│ (the published Docker image)    │
└─────────────────────────────────┘
```

Each service has a separate role:

- **The Worker** receives public requests. It serves the website itself, from the files deployed
  with it, so it can load while the container sleeps. It answers anonymous API reads from
  Cloudflare's cache when it can, and serves published translation files (`/files/…`) straight from
  D1 and R2, without waking the container for those files. It forwards everything else to the server
  in the container.
- **The container** runs the same image as Docker Compose, the one published on Docker Hub. It runs
  the whole service: accounts, translations, LLM jobs and backups. Its disk does not hold lasting
  project data: it reaches the database and the files through two private bindings that only the
  container can use, never the internet. In production, it can sleep after 10 minutes without
  requests (`sleepAfter`). It stays awake while background work is busy. A request that needs the
  server starts it again; the time depends on Cloudflare and the server's startup work. Opening the
  website wakes it too: the website shows **Waking up Quaso…** with a progress bar until the server
  answers, and the CLI waits and says so before its first request. It also wakes up by itself for
  scheduled work, such as LLM jobs and the nightly backup.
- **D1** is the database (Cloudflare's hosted SQLite): accounts, project settings, strings,
  translations, history and settings. [Time Travel](#backups-and-recovery) provides database
  recovery.
- **R2** holds published files, retained file versions and the nightly backups.

A small Durable Object, `QuasoContainer`, starts and stops the container. It holds no project data.

Everything is in `packages/cloudflare` of the repository. `wrangler.jsonc` there is a template:
`cf:setup` and `cf:deploy` fill in your account, hostname, database, bucket and image from your
instance settings, `quaso.cloudflare.jsonc`. Keep account details out of the shared template.

## Optional settings

The Worker passes the following settings to the server: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`LOG_LEVEL` and `CORS_ORIGINS` (only when the website is served from another origin; the Worker's
cache then keeps one copy of each anonymous read per origin). Configure email and machine
translation in **Settings** instead. The [configuration reference](configuration.md) explains each.
Set one as a Worker secret, which Wrangler asks for:

```sh
cd packages/cloudflare
deno run -A npm:wrangler secret put GITHUB_CLIENT_SECRET --name quaso-production
cd ../..
```

## Changing the instance

To change the hostname, the image or how long the container stays awake, edit the environment in
`quaso.cloudflare.jsonc` (`hostname`, `image`, `sleepAfter` such as `10m`), then deploy:

```sh
deno task cf:deploy --env production
```

`cf:deploy` requires `--env`. `cf:setup` can resume incomplete setup, but refuses changed settings
for an existing instance.

For a one-time image choice, pass `--image "$QUASO_IMAGE"` to `cf:deploy`. This overrides the saved
image for that deployment without changing `quaso.cloudflare.jsonc`. A later deployment without
`--image` uses the saved image again.

### How long to stay awake

Choose `sleepAfter` to balance waits and cost. A request that needs a sleeping container must wait
for Cloudflare to start it and for Quaso to check its database. The website shows **Waking up
Quaso…** while it waits; the CLI also waits. Startup time depends on the platform and database work.

| `sleepAfter` | Effect when no requests or background work keep the server busy     |
| ------------ | ------------------------------------------------------------------- |
| `10m`        | Sleep after a short pause; later requests can wait for a new start. |
| `1h`         | Stay awake across longer pauses, with more billed idle time.        |
| `24h`        | Stay awake between days of use, with more billed idle time.         |

The supplied `basic` container has 1 GiB of memory, 4 GB of disk and a quarter of a virtual CPU. At
October 2026 rates, its memory and disk together cost about US$0.01 per awake hour after the
included allowances. This is calculated from the published per-second rates; it is not a total
monthly estimate. CPU usage, the Workers Paid plan, other services and traffic can add charges.
Memory and disk are billed while the container is awake even when idle. See
[Cloudflare's container pricing](https://developers.cloudflare.com/containers/platform/pricing/) for
rates and allowances.

## Updates

Take a backup and record the current source commit, image and UTC time before an update. Test the
backup and new version on staging. Check out the target source commit or tag in a clean checkout,
run `deno install --frozen-lockfile`, and set `image` in `quaso.cloudflare.jsonc` to the matching
published image. Keep the instance configuration in the repository root, then deploy:

```sh
deno task cf:deploy --env production
```

Wrangler activates the new Worker before updating the container. A failure can leave those versions
out of step, and a successful deploy can still have containers waiting to update. This order is
described in
[Cloudflare's deployment guide](https://developers.cloudflare.com/containers/guides/deploy/).
Quaso's controller records which deployment started the server. On a later request with no other
requests in progress, it stops an older server if `/healthz` reports `busy: false`, then starts it
with the deployed image and settings. This also applies to deployments that only change secrets.
Running jobs or exports delay that restart; requests can still reach the older server during the
transition.

The server migrates the database the first time the new release starts. Check `/healthz` for the
chosen version, then check sign-in and a download. Migrations only move forwards. For a schema
rollback, use the pre-upgrade export in a separate empty deployment with the previous source and
image; see [operations](operations.md#upgrades-and-rollbacks).

## Backups and recovery

Use D1 Time Travel for database recovery with a compatible server, or a backup file to restore into
an empty instance. Keep a copy outside the hosting account. The options are:

- **D1 Time Travel.** The Workers Paid plan keeps 30 days of database history. See
  [Cloudflare's Time Travel reference](https://developers.cloudflare.com/d1/reference/time-travel/).
  To restore D1 to a point in that window, discarding database writes made since then:

  ```sh
  deno task cf:restore --env production --at 2026-10-03T00:00:00Z
  ```

  This overwrites D1 in place. The command deploys maintenance mode, stops the container, and
  confirms its exit before restoring. API and published-file requests get 503 while paused; the
  website still loads, and scheduled starts cannot restart the server. It prints the previous
  bookmark before making the restore request, then the undo bookmark returned by Cloudflare. Save
  these. The existing container image stays deployed: neither maintenance deployment builds an
  image.

  To undo, replace the quoted placeholder with the saved bookmark:

  ```sh
  deno task cf:restore --env production --bookmark '<undo-bookmark>'
  ```

  Successful restoration removes maintenance mode and checks `/healthz`. The new deployment starts a
  fresh API cache so responses from the discarded database timeline are not reused. A failure can
  leave the instance paused. After checking D1 and confirming the earlier command is no longer
  running, retry the intended timestamp or bookmark with `--takeover`; this retains the pause
  through the retry. To keep the database as it is and return to service, use
  `deno task cf:restore --env production --resume`. The command removes generated configuration and
  its temporary control secret; check any cleanup error. R2 is not rewound by D1 Time Travel.
  Restored D1 rows can only serve older files if those R2 objects still exist. File-history cleanup
  can remove them. Check downloads after recovery. Time Travel also restores database secrets and
  sessions, unlike a portable backup import.

- **The nightly backup file.** At 03:00 UTC, the server writes the whole instance as gzip-compressed
  JSON to the R2 bucket, as `backups/quaso-<UTC time>.json.gz`, and deletes files older than the
  backup retention set in **Settings → History & retention** (30 days by default). A request that
  changes the data while the file is written starts it again. The admin page shows the last one.
  Download one with the following command (replace the bucket and the timestamp with yours):

  ```sh
  cd packages/cloudflare
  deno run -A npm:wrangler r2 object get \
    quaso-production-store/backups/quaso-20260924T030000Z.json.gz \
    --file ../../backup.json.gz --remote
  cd ../..
  ```

- **A download.** Administrators download a backup from the Settings page, or from
  `GET /api/v1/backup?format=sqlite` (one SQLite file) or `?format=json`.

Cloudflare backup exports read the database in chunks. If another write changes the data, the export
restarts to produce one consistent copy. After three failed attempts, a backup download returns 503.
Retry during a quiet period. Export files leave out provider keys and sessions; enter the Gemini and
email keys again in **Settings** after restoring.

A downloaded backup file restores into an **empty** instance of either kind (with no strings and no
one with a role), which is also how an instance moves between setups. People sign in again: sessions
aren't part of backups; API keys are. A restore that fails part way can be run again, as long as
nothing else has written to the instance since; once it has been used, the admin page says the
restore didn't finish, and the backup only goes into another, empty instance.

- **Into Docker Compose:** on a new VM, before the first start (or with an empty data folder):

  ```sh
  docker compose run --rm -v "$PWD/backup.json.gz:/backup.json.gz:ro" quaso restore /backup.json.gz
  docker compose up -d
  ```

- **Into Cloudflare storage:** run `cf:setup`, and before creating the first administrator, run the
  restore command with the setup key it printed:

  ```sh
  deno task cf:restore --env production --file backup.json.gz
  ```

  The command asks for the setup key; automation can supply `QUASO_SETUP_KEY` through its
  environment. It accepts SQLite, JSON and gzip JSON, streams the file unchanged, and refuses files
  larger than 1 GiB. The server refuses imports into an instance that is already set up. An
  interrupted restore can resume with the same backup and key.

Compare status, downloaded files, roles and history before switching DNS. Keep the old deployment
stopped and available until that comparison passes.

A backup with an older supported schema is migrated after import. A newer schema is refused; upgrade
Quaso first. Backups from 1.0.0-rc.1 are not supported; see
[the format change](operations.md#coming-from-100-rc1).

## Deploying from your own infrastructure code

If you manage D1 databases, R2 buckets, zone settings or secrets with infrastructure code such as
Terraform, use `cf:deploy` for the Worker and container. Check out the matching Quaso source, run
`deno install --frozen-lockfile`, and provide your own instance file and secrets. For files in the
repository root, use absolute paths because the deployment task changes its working directory:

```sh
deno task cf:deploy --env production \
  --instance-config "$PWD/instance.jsonc" --secrets-file "$PWD/secrets.json"
```

Prepare and check the deployment as follows:

1. Give `instance.jsonc` the same shape as `quaso.cloudflare.jsonc`: `version: 1` and an
   `environments` entry with the account, hostname, Worker name, image, database ID and name, bucket
   name, location hint and sleep timeout. Use the IDs and names your infrastructure created.
2. Put at least `SECRET_KEY` in `secrets.json`, and `SETUP_KEY` until the first administrator
   exists. Create the file with mode 600, keep it out of git, and delete it after deployment.
3. Pin the server, source and CLI together. Check that the matching image is on Docker Hub before
   deploying; see [release and main versions](releasing.md#what-every-push-to-main-publishes).
4. Wait for `/healthz` to report `ok: true`, `storage: "cloudflare"` and the chosen server version
   before running the CLI.

`cf:deploy` builds the website with Vite before uploading the Worker. It does not create the storage
resources named in your instance file.

## Staging

`--env staging` is a second, separate instance: its own Worker (`quaso-staging`), database, bucket,
container and secrets. Give it its own hostname, such as `staging.translate.yourgame.com`. This
package disables Worker preview URLs. Use staging to test a release before production.

## Measure it

`scripts/measure.ts` times an instance from the outside, and prints a table:

```sh
deno run -A scripts/measure.ts --url https://translate.yourgame.com \
  --key qso_… --requests 50
```

- **Response times:** each endpoint 50 times, reporting the median (p50) and 95th percentile (p95)
  for response headers and the complete response. Reads carrying the API key bypass the API cache
  and reach the server. The script also keeps anonymous comparison reads; those show the cache
  (`X-Quaso-Cache: hit`).
- **Cold starts:** add `--cold-starts 3 --sleep 660`. It waits 11 minutes before each `/healthz`
  request, which is never cached. Use a wait longer than your `sleepAfter` value. Other traffic or
  scheduled work can keep the container awake, so these samples do not prove that it slept.

Run it from where your team works, and against a Docker Compose instance for comparison.

## Local runs

`deno task cf:dev` runs the Worker and the container on your machine with Wrangler, on Wrangler's
local D1 and R2. Docker must be running; the first run builds the image from `deploy/Dockerfile`.
Copy `packages/cloudflare/.dev.vars.example` to `packages/cloudflare/.dev.vars`. Set `SECRET_KEY`
and `SETUP_KEY` as described in [the contributor guide](contributing/cloudflare.md#run-locally).
Then open <http://localhost:8787>.

`deno task cf:test` runs the package's tests in `workerd`, without Docker or an account.

## Troubleshooting

Use these checks when deployment or startup fails:

- **Worker error 1101 or a bare HTTP 500:** read the Worker's exceptions while you repeat the
  request. Replace the Worker name if you changed it. Stop the log stream with Ctrl+C, then return
  to the repository root:

  ```sh
  cd packages/cloudflare
  deno run -A npm:wrangler tail quaso-production --format json
  cd ../..
  ```

- **Server errors:** read its JSON logs, including startup and migrations, in the Cloudflare
  dashboard under **Workers & Pages → your Worker → Logs**. An API token needs Workers Observability
  Read for these logs.
- **Repeated startup failures or HTTP 503:** check the container state in the dashboard's
  **Containers** page and read the server logs for the cause, such as a missing secret. A 503 can
  also mean the instance is paused for restoration; check whether a restore is still running.
- **A new hostname does not resolve:** check that the Custom Domain exists and is active. A lookup
  made before creation can leave a cached negative DNS answer. Try another network or wait for that
  cached answer to expire.
- **The first deploy waits for `/healthz`:** check image availability and the Custom Domain's
  certificate status. First-time image setup can take minutes; a Worker URL can respond before the
  container is ready. See
  [Cloudflare's deployment guide](https://developers.cloudflare.com/containers/guides/deploy/).

## Limits to know

Account for these limits when testing your deployment:

- **One container** (`max_instances: 1`). Test with your project data and expected request load
  before choosing this setup.
- **Request bodies:** source uploads and translation imports accept up to 50 MiB of JSON. Other
  routes have their own limits. The backup restore script accepts files up to 1 GiB; the Cloudflare
  account plan can impose a lower limit on the incoming request; check
  [request limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits).
- **The cache** keeps anonymous API reads for their `Cache-Control` time (30 seconds), and serves
  them stale for a while as it refreshes them. API requests with a cookie or API key bypass this
  cache. Published files still use the direct D1/R2 route, with permission checks there. The
  website's hashed files are kept by browsers for a year; its page is checked for a new version on
  every visit.
