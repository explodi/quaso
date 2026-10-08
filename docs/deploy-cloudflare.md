# Deploy on Cloudflare

This guide runs Quaso on your own Cloudflare account, with no server of your own to look after. It
is the setup for teams that already use Cloudflare. For most teams,
[Docker Compose on a VM](deploy-docker.md) is simpler.

Test a deployment and a restore on staging before sending production traffic to it. See
[operations](operations.md) for a drill checklist and rollback steps.

## How it fits together

```text
 Browsers, the CLI
        │ https://translate.yourgame.com
        ▼
┌─────────────────────────────────┐        ┌──────────────────────────────┐
│ Worker                          │        │ Durable Object "QuasoData":  │
│  anonymous reads: its cache     │        │ the service and its SQLite   │
│  /internal/v1/…: to the data  ──┼───────►│ data, the LLM jobs, backups  │
│  everything else: the container │        └──────────────────────────────┘
└───────┬────────────────▲────────┘
        │                │ /internal/v1/… with SERVICE_TOKEN
        ▼                │
┌────────────────────────┴────────┐
│ Container: the Quaso server     │
│ (the same Docker image)         │
└─────────────────────────────────┘
```

- **The Worker** is the front door. It answers anonymous reads (the website's files, public API
  reads) from Cloudflare's cache when it can, so bots and visitors rarely wake the container. It
  forwards everything else to the server in the container.
- **The container** runs the same image as Docker Compose (`deploy/Dockerfile`). Its disk is wiped
  whenever it stops, so it keeps nothing: it reaches the data through the Worker's internal API, at
  `https://<your domain>/internal`, with a shared secret (`SERVICE_TOKEN`). It goes to sleep after
  10 minutes without requests (`CONTAINER_SLEEP_AFTER`), and wakes up on the next request the cache
  can't answer, which takes a few seconds.
- **The Durable Object** holds the whole database in its SQLite storage, runs the service, and runs
  the LLM jobs (so the Gemini key stays there, never in the container). Cloudflare keeps 30 days of
  point-in-time recovery for it.

Everything is in `packages/cloudflare` of the repository: `wrangler.jsonc` describes the Worker,
both Durable Objects, the container, an R2 bucket for backups, and a `staging` and a `production`
environment.

## What you need

- A Cloudflare account on the **Workers Paid** plan (Containers and Durable Objects with SQLite need
  it), and a domain on Cloudflare, such as `yourgame.com`.
- [Deno](https://deno.com) 2.9.6 and git, to run Wrangler from the repository.
- [Docker](https://docs.docker.com/get-docker/), running: `wrangler deploy` builds the image.
- `openssl`, or another way to make long random strings.

Get the code and Wrangler:

```sh
git clone 'https://github.com/<org>/quaso.git'
cd quaso
deno install
```

Every direct Wrangler command below runs from `packages/cloudflare`. Run `deno task cf:*` commands
from the repository root unless stated otherwise.

## 1. Sign in to Cloudflare

```sh
cd packages/cloudflare
deno run -A npm:wrangler login
```

## 2. Choose the names

Open `packages/cloudflare/wrangler.jsonc`. Each environment repeats all its settings, because
Wrangler doesn't inherit them. In `env.production` (and `env.staging`, if you want one):

- `vars.PUBLIC_URL`: the address people will use, such as `https://translate.yourgame.com`, without
  a trailing slash.
- `routes`: remove the `//` in front of the line, and put your hostname in it. The Worker must be on
  a custom domain: Cloudflare's cache and the internal API work there, not on `workers.dev`. Turn on
  **Always Use HTTPS** for the zone (SSL/TLS, Edge Certificates): the internal API refuses plain
  `http`, because its token would cross the network in the clear.
- `vars.LOCATION_HINT`: where the Durable Object is created, near your team: `weur` or `eeur`
  (Europe), `wnam` or `enam` (North America), `apac`, `oc`, `sam`, `afr` or `me`. Empty means near
  the first request. It is decided once, when the object is created.
- `vars.CONTAINER_SLEEP_AFTER`: how long the container stays awake without requests, such as `10m`.
  Shorter costs less; longer means fewer cold starts.
- `r2_buckets[0].bucket_name`: the bucket for backups. Create it:

  ```sh
  deno run -A npm:wrangler r2 bucket create quaso-production-backups
  ```

After changing `wrangler.jsonc`, run `deno task cf:types` (from the repository's root), which
updates `worker-configuration.d.ts`.

## 3. Prepare the secrets

Secrets never go in `wrangler.jsonc`. Three are required, and a new Worker can't have secrets before
its first deploy, so the first deploy of each environment takes them from a file. Copy
`packages/cloudflare/.dev.vars.example` to `packages/cloudflare/.dev.vars.production` (git ignores
it, and `.dockerignore` keeps it out of the image build, which runs from the repository's root) and
fill it in:

- `SECRET_KEY` signs sessions and is mixed into password hashes: `openssl rand -hex 32`. Keep a copy
  somewhere safe: changing it signs everyone out and invalidates existing password hashes; users
  must reset passwords.
- `SERVICE_TOKEN` lets the server in the container call the Durable Object: `openssl rand -hex 32`
  as well. Nothing outside needs it, unless you run the server elsewhere (below).

After creating the administrator, enter the Gemini API key and choose the model, parallel
requests and monthly budget in Settings → LLM translation. The server reads this stored
configuration in both setups. Without a key, LLM translation is off.

Optional ones, passed to the server when set: `SETUP_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `LOG_LEVEL` and
`CORS_ORIGINS` (only when the website is served from another origin; the Worker's cache then keeps
one copy of each anonymous read per origin). The [configuration reference](configuration.md)
explains each. Set them after the first deploy.

Later, change or add a secret with Wrangler, which asks for the value:

```sh

```

## 4. Deploy

From the repository's root:

```sh
# The first time, with the secrets file:
deno task cf:deploy --env production --secrets-file .dev.vars.production
# Afterwards (the secrets stay):
deno task cf:deploy --env production
```

The same with `--env staging` (and `.dev.vars.staging`) if you have a staging environment. The first
deploy pulls the published image (`explodi/quaso` on Docker Hub, or one of your own) for
`linux/amd64`, transfers it to the account's Cloudflare registry, and deploys the transferred
digest. Docker must be running for this transfer; deployment does not build the image. A private
image requires Docker to be logged into its registry. An account-owned `registry.cloudflare.com/<account-id>/quaso@sha256:<digest>`
reference skips the transfer and needs no local Docker daemon. Dry runs skip the transfer.
`cf:deploy` refuses to run without `--env`: the top level of `wrangler.jsonc` is only for local
runs. Once deployed, you can delete the secrets file, or keep it somewhere safer.

Then check it:

```sh
curl https://translate.yourgame.com/healthz
```

The first request wakes the container, which takes a few seconds. The answer says
`"storage": "cloudflare"`. Open `/setup`, enter the key printed once by `cf:setup`, and create the first
administrator account. Create an API key in **Settings → API keys**, or use the server's
`token create` command through the internal API:

```sh
export SERVICE_TOKEN='your Worker service token'
export SECRET_KEY='your original instance secret key'
docker run --rm \
  -e SERVICES_URL=https://translate.yourgame.com/internal \
  -e SERVICE_TOKEN \
  -e SECRET_KEY \
  'explodi/quaso:latest' token create --name ci --scope upload
```

## Updates

Once the instance is running, follow [From your repository to every language](workflow.md)
to connect your game and run the translation workflow, or [Migrate from Crowdin](migrate-from-crowdin.md)
to bring existing translations and their proofread state.

Pull the new version and run `deno task cf:deploy --env production` again. Wrangler activates the
new Worker first and then rolls out the new image, so for a while the new Worker talks to the old
server: the internal API always accepts the previous release's calls. The Durable Object migrates
its database the first time it starts with the new code. Take a backup before upgrading. Record the
previous source commit and a UTC timestamp for PITR. For rollback, recover the data as well as the
code; the [operations guide](operations.md#upgrades-and-rollbacks) describes both the PITR and
separate-instance paths.

## Backups and recovery

Three ways back, from the quickest to the most portable:

- **Point-in-time recovery.** Cloudflare keeps 30 days of history of the Durable Object's storage.
  To put the whole instance back to how it was at a moment in that window (everything written since
  is lost), call the Worker's internal API with the `SERVICE_TOKEN` secret:

  ```sh
  curl -X POST https://translate.yourgame.com/internal/v1/pitr \
    -H "Authorization: Bearer <the SERVICE_TOKEN secret>" \
    -H "Content-Type: application/json" \
    -d '{ "at": "2026-09-24T03:00:00Z" }'
  ```

  The answer is `{ "ok": true, "at": …, "bookmark": … }`: the Durable Object restarts on its data as
  it was then, and the server reconnects by itself. A recovery can itself be undone within the
  window: go back to the time just before you ran it. It only works on a deployed Worker
  (`wrangler dev` and the tests answer 400: their storage can't go back).

- **The nightly backup file.** At 03:00 UTC, the Durable Object writes the whole instance as
  gzip-compressed JSON to the R2 bucket (`BACKUPS`), as `backups/quaso-<UTC time>.json.gz`, and
  deletes files older than the backup retention set in Settings → Retention (30 days by
  default). A request that changes the data while the file is written starts it again (after three
  tries it waits an hour). The admin page shows the last one. Download one with the following
  command (replace the timestamp with the backup you want):

  ```sh
  deno run -A npm:wrangler r2 object get \
    quaso-production-backups/backups/quaso-20260924T030000Z.json.gz \
    --file backup.json.gz --remote --env production
  ```

- **A download.** Administrators download a backup from the Settings page, or from
  `GET /api/v1/backup?format=sqlite` (one SQLite file, which the server builds from the Durable
  Object's data in a temporary file, then sends) or `?format=json`.

Each file is the instance at one moment. The Durable Object's data is read in many steps, so if it
changes meanwhile (an LLM job, people translating), the backup starts again; after three tries a
download answers 503 and asks you to try again later.

Any of these files restores into an **empty** instance of either kind (with no strings and no one
with a role), which is also how an instance moves between setups. People sign in again: sessions
aren't part of backups; API keys are. A restore that fails part way can be run again, as long as
nothing else has written to the instance since; once it has been used, the admin page says the
restore didn't finish, and the backup only goes into another, empty instance.

- **Into Docker Compose:** on a new VM, before the first start (or with an empty data folder), with
  the backup's `SECRET_KEY` in `.env`:

  ```sh
  docker compose run --rm -v "$PWD/backup.json.gz:/backup.json.gz:ro" quaso restore /backup.json.gz
  docker compose up -d
  ```

- **Into Cloudflare storage, without a shell:** deploy, and before creating the first administrator,
  run the restore command with the setup key printed by `cf:setup`:

  ```sh
  deno task cf:restore --env production --file backup.json.gz
  ```

  The command asks for the setup key; automation can supply `QUASO_SETUP_KEY` through its
  environment. It accepts SQLite, JSON and gzip JSON, streams the file unchanged, and refuses
  files larger than 1 GiB. The server refuses imports into an instance that is already set up.
  An interrupted restore can resume with the same backup and key. Preserve the original
  instance's `SECRET_KEY` on the destination before restoring so password hashes remain valid.

To restore the existing D1 database to an earlier time, use the account authenticated with
Wrangler. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) accepts
any minute within the last 30 days on Workers Paid:

```sh
deno task cf:restore --env production --at 2026-10-03T00:00:00Z
```

This overwrites D1 in place. The command deploys maintenance mode, stops the container,
and confirms its exit before restoring. Public requests get 503 while paused; scheduled
starts cannot restart the server. It prints the previous bookmark before making the restore
request, then the undo bookmark returned by Cloudflare. Save these. The existing container
image stays deployed: neither maintenance deployment builds or transfers an image.

To undo, use the saved bookmark:

```sh
deno task cf:restore --env production --bookmark <undo-bookmark>
```

Successful restoration removes maintenance mode and checks `/healthz`. The new deployment
starts a fresh API cache so responses from the discarded database timeline are not reused.
A failure can leave
the instance paused. After inspecting D1 and confirming the earlier command is no longer
running, retry the intended timestamp or bookmark with `--takeover`; this retains the pause
through the retry. To keep the database as it is and return to service, use
`deno task cf:restore --env production --resume`. Temporary control secrets and generated
configuration files are removed after each command. R2 is not rewound by D1 Time Travel;
the restored D1 pointers select retained immutable file objects.

Moving back to local storage uses the Docker restore command above with a new volume. Compare
status, downloaded files, roles and history before switching DNS. Keep the old deployment stopped
and available until that comparison passes.

The `SECRET_KEY` must be the one the backup's instance used (with local storage, the generated one
is in the data folder's `secret-key` file), or people's passwords won't match.

A backup from an older release is migrated after the import; one from a newer release is refused
(upgrade first).

## Staging

`env.staging` is a second, separate instance: its own Worker (`quaso-staging`), Durable Object,
container, bucket and secrets. Give it its own hostname, such as `staging.translate.yourgame.com`.
Cloudflare doesn't make preview URLs for Workers with Durable Objects, so staging is how to try a
release first.

## A VM with Cloudflare storage

You can also keep the data in the Durable Object and run the server anywhere Docker runs: to try
Cloudflare storage, or to move an instance between setups.

1. Deploy the Worker as above, with `SERVICE_TOKEN` and `SECRET_KEY` set. (Its container then stays
   asleep unless someone opens the Worker's own address.)
2. Run the image on the VM with the same token and key, and with `SERVICES_URL` pointing at the
   Worker:

   ```sh
   docker run -d -p 8000:8000 \
     -e SERVICES_URL=https://translate.yourgame.com/internal \
     -e SERVICE_TOKEN \
     -e SECRET_KEY \
     -e PUBLIC_URL=https://translate-vm.yourgame.com \
     'explodi/quaso:latest'
   ```

   Or, with Docker Compose, add the three variables to `.env`. `SERVICES_URL` must use `https`.

The server then keeps nothing on the VM (no data folder, lock or snapshots), and the LLM jobs run in
the Durable Object, so the Gemini key belongs to the Worker. Every API request crosses the network
once more, which adds some latency: measure it (below). If the token is wrong, the Worker doesn't
know this release's internal API, or the Worker's own settings are wrong (such as a short
`SECRET_KEY`), the server stops at once and says why. If the Worker doesn't answer, or answers 503
while a deploy restarts the Durable Object, the server starts anyway and `/healthz` answers 503
until it does; reads are tried again, up to three times. `token create` can't wait: it fails with a
one-line message, and you run it again.

## Measure it

`scripts/measure.ts` times an instance from the outside, and prints a table:

```sh
deno run -A scripts/measure.ts --url https://translate.yourgame.com \
  --key qso_… --requests 50
```

- **Response times through the extra hop:** each endpoint 50 times, p50 and p95, to the first byte
  and to the last. Reads with `--key` bypass the cache and cross every hop (Worker, container,
  internal API, Durable Object); anonymous reads show the cache (`X-Quaso-Cache: hit`).
- **Cold starts:** add `--cold-starts 3 --sleep 660`. It waits 11 minutes (longer than
  `CONTAINER_SLEEP_AFTER`) before each `/healthz`, which is never cached.

Run it from where your team works, against both setups (Cloudflare, and a VM with Cloudflare
storage), and against a Docker Compose instance for comparison.

## Local runs

`deno task cf:dev` runs the Worker, the Durable Object and the container on your machine with
Wrangler (Docker must be running; the first run builds the image for `linux/amd64`, which is slow on
other machines). Copy `packages/cloudflare/.dev.vars.example` to `packages/cloudflare/.dev.vars` and
fill in the three required secrets; locally, Wrangler loads only those from it. The top level of
`wrangler.jsonc` points the container at `http://host.docker.internal:8787/internal`
(`SERVICES_URL`), because the container can't reach the Worker at `localhost`. Then open
<http://localhost:8787>.

`deno task cf:test` runs the package's tests in `workerd`, without Docker or an account.

## Limits to know

- **One container, one Durable Object.** One game's traffic is far below what either handles.
- **Request bodies:** an upload of 50 MB of JSON is the most the server takes. The Durable Object
  has 128 MB of memory, so very large uploads are better split by file.
- **The cache** keeps anonymous reads for their `Cache-Control` time (30 seconds for the API, a few
  minutes for the website's page, a year for its hashed files), and serves them stale for a while as
  it refreshes them. Signed-in requests and API keys always reach the server.
