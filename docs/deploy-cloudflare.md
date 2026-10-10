# Deploy on Cloudflare

This guide runs Quaso on your own Cloudflare account, with no server of your own to look after. It
is the setup for teams that already use Cloudflare. For most teams,
[Docker Compose on a VM](deploy-docker.md) is simpler.

Test a deployment and a restore on staging before sending production traffic to it. See
[operations](operations.md) for a drill checklist and rollback steps.

## How it fits together

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

- **The Worker** is the front door. It serves the website itself, from the files deployed with it,
  so the website is on screen at once even while the container sleeps. It answers anonymous API
  reads from Cloudflare's cache when it can, and serves published translation files (`/files/…`)
  straight from D1 and R2, so games, bots and visitors rarely wake the container. It forwards
  everything else to the server in the container.
- **The container** runs the same image as Docker Compose, the one published on Docker Hub. It runs
  the whole service: accounts, translations, LLM jobs and backups. Its disk is wiped whenever it
  stops, so it keeps nothing there: it reaches the database and the files through two private
  bindings that only the container can use, never the internet. It goes to sleep after 10 minutes
  without requests (`sleepAfter`), and wakes up on the next request the cache can't answer, which
  can take a minute. Opening the website wakes it too: the website shows "Waking up Quaso…" with
  a progress bar until the server answers, and the CLI waits and says so before its first
  request. It also wakes up by itself for scheduled work, such as LLM jobs and the nightly backup.
- **D1** is the database (Cloudflare's hosted SQLite): accounts, projects, strings, translations,
  history and settings. Cloudflare keeps 30 days of [Time Travel](#backups-and-recovery) for it.
- **R2** holds the bytes of uploaded and published files, and the nightly backups.

A small Durable Object, `QuasoContainer`, starts and stops the container. It holds no project data.

Everything is in `packages/cloudflare` of the repository. `wrangler.jsonc` there is a template:
`cf:setup` and `cf:deploy` fill in your account, hostname, database, bucket and image from your
instance settings, `quaso.cloudflare.jsonc`, so you never edit the template.

## What you need

- A Cloudflare account on the **Workers Paid** plan (Containers need it), and a domain on
  Cloudflare, such as `yourgame.com`.
- [Deno](https://deno.com) 2.9.6 and git, to run the commands from the repository. Docker isn't
  needed: Cloudflare pulls the published image from Docker Hub itself.

Get the code:

```sh
git clone 'https://github.com/explodi/quaso.git'
cd quaso
deno install
```

Run every `deno task cf:*` command from the repository's root.

## 1. Sign in to Cloudflare

```sh
cd packages/cloudflare
deno run -A npm:wrangler login
cd ../..
```

For automation, Wrangler reads an API token from `CLOUDFLARE_API_TOKEN` (and the account from
`CLOUDFLARE_ACCOUNT_ID`) instead. The token needs these permissions:

- Account: Workers Scripts Edit, Containers Edit, D1 Edit, Workers R2 Storage Edit, Account
  Settings Read.
- Zone, for the domain Quaso runs on: Workers Routes Edit, DNS Edit, Zone Read.
- Optional, to read logs when something goes wrong ([Troubleshooting](#troubleshooting)): Workers
  Tail Read and Workers Observability Read.

## 2. Create the instance

`cf:setup` creates everything an instance needs and deploys it:

```sh
deno task cf:setup --env production --hostname translate.yourgame.com \
  --location weur --image explodi/quaso:1.0.0-rc.2
```

Leave out any option and it asks. The options:

- `--env`: `production` or `staging`. Each environment is a separate instance with its own Worker,
  database, bucket and secrets.
- `--hostname`: the address people will use, in an active domain of the account. The Worker gets it
  as a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):
  Cloudflare creates its DNS record and certificate, so the hostname must not have a DNS record yet.
- `--location`: where the D1 database and the R2 bucket are created, near your team: `weur` or
  `eeur` (Europe), `wnam` or `enam` (North America), `apac` or `oc`. Empty means automatic. It is
  decided once, when they are created.
- `--image`: the release to run, a tag or digest of the published image, such as
  `explodi/quaso:1.0.0-rc.2` or `explodi/quaso@sha256:…`. Pin a version rather than `latest`, so a
  deploy always gets the release you expect.
- `--name`: the Worker's name, `quaso-production` or `quaso-staging` by default. The database takes
  the same name and the bucket `<name>-store`.
- `--check`: only check that the account has Container access and list its domains; create nothing.

Setup then:

1. checks that the account can run Containers (Workers Paid),
2. creates the D1 database and the R2 bucket, unless they already exist,
3. saves the instance settings in `quaso.cloudflare.jsonc` at the repository's root (git ignores
   it),
4. generates the Worker's secrets, `SECRET_KEY` and `SETUP_KEY`, and prints the setup key once:
   save it,
5. deploys the Worker with the image as `docker.io/<image>`, which Cloudflare pulls from Docker
   Hub, and waits until `https://<hostname>/healthz` answers.

Keep a copy of `quaso.cloudflare.jsonc` somewhere safe, such as your password manager or the
repository that holds your infrastructure: it names the database by its ID, and every later deploy
reads it. If setup stops part way, run it again with the same options: it picks up where it
stopped.

Turn on **Always Use HTTPS** for the zone (SSL/TLS, Edge Certificates), so nobody signs in over
plain `http`.

## 3. Create the administrator

Open `https://translate.yourgame.com`, enter the setup key, and create the first administrator
account. Then, in Settings:

- **LLM translation:** enter the Gemini API key, and choose the model, parallel requests and monthly
  budget. Without a key, LLM translation is off.
- **API keys:** create one for each integration, such as an `upload` key for CI.

Check it from outside:

```sh
curl https://translate.yourgame.com/healthz
```

The answer says `"storage": "cloudflare"`.

Then follow [From your repository to every language](workflow.md) to connect your game, or
[Migrate from Crowdin](migrate-from-crowdin.md) to bring existing translations and their proofread
state.

## Optional settings

The Worker passes these to the server when they are set: `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`,
`TURNSTILE_SECRET_KEY`, `LOG_LEVEL` and `CORS_ORIGINS` (only when the website is served from
another origin; the Worker's cache then keeps one copy of each anonymous read per origin). Email
and the LLM are set up in Settings instead. The [configuration reference](configuration.md)
explains each. Set one as a Worker secret, which Wrangler asks for:

```sh
cd packages/cloudflare
deno run -A npm:wrangler secret put GITHUB_CLIENT_SECRET --name quaso-production
```

## Changing the instance

To change the hostname, the image or how long the container stays awake, edit the environment in
`quaso.cloudflare.jsonc` (`hostname`, `image`, `sleepAfter` such as `10m`), then deploy:

```sh
deno task cf:deploy --env production
```

`cf:deploy` refuses to run without `--env`, and `cf:setup` refuses to change an instance that
already exists: it only creates.

### How long to stay awake

A sleeping container takes about a minute to start: Cloudflare places it, then the server checks
its database. The website is on screen at once meanwhile and shows "Waking up Quaso…" with a
progress bar, and the CLI waits and says so, but the first request still takes that minute.

The container is billed while it is awake, idle or not. On the `basic` instance (1/4 vCPU, 1 GiB
of memory, 4 GB of disk), awake time costs about US$0.01 an hour beyond what Workers Paid includes
(25 GiB-hours of memory a month), and CPU only while it works. At October 2026 prices:

| `sleepAfter`  | Cold starts                                     | Cost beyond Workers Paid      |
| ------------- | ----------------------------------------------- | ----------------------------- |
| `10m`         | after every pause of 10 minutes                 | usually nothing               |
| `1h`          | about once per working session                  | under US$1 a month            |
| a day or more | rarely; scheduled work still wakes it by itself | about US$7 a month, always on |

Check [Cloudflare's container pricing](https://developers.cloudflare.com/containers/pricing/)
for current prices.

## Updates

Pick the new release on [Docker Hub](https://hub.docker.com/r/explodi/quaso), and take a backup
first. Record the current `image` and a UTC timestamp, for [Time Travel](#backups-and-recovery). Set
`image` in `quaso.cloudflare.jsonc` to the new release, and deploy:

```sh
deno task cf:deploy --env production
```

Wrangler activates the new Worker first and then rolls out the new image, so for a while the new
Worker serves the old server. The container's controller (the `QuasoContainer` Durable Object) can
keep running the previous release until the container next stops, so a feature that needs both the
new Worker and the new controller, such as the waking-up progress, may only work after the next
cold start; the website keeps working meanwhile. An LLM job started during the rollout can run on
the old server. The server migrates the database the first time the new release
starts, and migrations only go forwards. To roll
back, recover the data as well as the code; the
[operations guide](operations.md#upgrades-and-rollbacks) describes how.

## Backups and recovery

Three ways back, from the quickest to the most portable:

- **D1 Time Travel.** Cloudflare keeps 30 days of history of the database. To put the whole
  instance back to how it was at a moment in that window (everything written since is lost):

  ```sh
  deno task cf:restore --env production --at 2026-10-03T00:00:00Z
  ```

  This overwrites D1 in place. The command deploys maintenance mode, stops the container, and
  confirms its exit before restoring. Public requests get 503 while paused; scheduled starts cannot
  restart the server. It prints the previous bookmark before making the restore request, then the
  undo bookmark returned by Cloudflare. Save these. The existing container image stays deployed:
  neither maintenance deployment builds an image.

  To undo, use the saved bookmark:

  ```sh
  deno task cf:restore --env production --bookmark <undo-bookmark>
  ```

  Successful restoration removes maintenance mode and checks `/healthz`. The new deployment starts a
  fresh API cache so responses from the discarded database timeline are not reused. A failure can
  leave the instance paused. After inspecting D1 and confirming the earlier command is no longer
  running, retry the intended timestamp or bookmark with `--takeover`; this retains the pause
  through the retry. To keep the database as it is and return to service, use
  `deno task cf:restore --env production --resume`. Temporary control secrets and generated
  configuration files are removed after each command. R2 is not rewound by D1 Time Travel; the
  restored D1 pointers select retained immutable file objects.

- **The nightly backup file.** At 03:00 UTC, the server writes the whole instance as gzip-compressed
  JSON to the R2 bucket, as `backups/quaso-<UTC time>.json.gz`, and deletes files older than the
  backup retention set in Settings → Retention (30 days by default). A request that changes the data
  while the file is written starts it again. The admin page shows the last one. Download one with
  the following command (replace the bucket and the timestamp with yours):

  ```sh
  cd packages/cloudflare
  deno run -A npm:wrangler r2 object get \
    quaso-production-store/backups/quaso-20260924T030000Z.json.gz \
    --file backup.json.gz --remote
  ```

- **A download.** Administrators download a backup from the Settings page, or from
  `GET /api/v1/backup?format=sqlite` (one SQLite file) or `?format=json`.

Each file is the instance at one moment. The database is read in many steps, so if it changes
meanwhile (an LLM job, people translating), the backup starts again; after three tries a download
answers 503 and asks you to try again later.

Any of these files restores into an **empty** instance of either kind (with no strings and no one
with a role), which is also how an instance moves between setups. People sign in again: sessions
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

A backup from an older release is migrated after the import; one from a newer release is refused
(upgrade first).

## Deploying from your own infrastructure code

The Cloudflare Terraform provider can describe the D1 database, the R2 bucket, the zone's settings
(such as Always Use HTTPS) and generated secrets, but not a Worker with a container. Keep those in
your infrastructure code, and deploy the Worker with `cf:deploy` from a checkout of the Quaso
release you pin, giving it your own instance file and secrets instead of `cf:setup`'s:

```sh
deno task cf:deploy --env production --instance-config instance.jsonc --secrets-file secrets.json
```

- `instance.jsonc` has the shape of `quaso.cloudflare.jsonc` (`version: 1` and an `environments`
  entry), with the database ID and bucket name your infrastructure created.
- `secrets.json` holds at least `SECRET_KEY`, and `SETUP_KEY` until the administrator exists. Write
  it with mode 600 and delete it afterwards.
- Pin the server and the CLI together. A release has an image tag and a CLI version of the same
  number; a commit on main has the image `sha-<first 7>` and the CLI `<version>.main.g<first 7>`.
  Check that the image is on Docker Hub before deploying.
- Wait for `https://<hostname>/healthz` to report `"storage":"cloudflare"` before running the CLI.

`cf:deploy` builds the website with Vite before it uploads the Worker, so the checkout needs
`deno install` first.

## Staging

`--env staging` is a second, separate instance: its own Worker (`quaso-staging`), database, bucket,
container and secrets. Give it its own hostname, such as `staging.translate.yourgame.com`. Cloudflare
doesn't make preview URLs for Workers with Durable Objects, so staging is how to try a release first.

## Measure it

`scripts/measure.ts` times an instance from the outside, and prints a table:

```sh
deno run -A scripts/measure.ts --url https://translate.yourgame.com \
  --key qso_… --requests 50
```

- **Response times:** each endpoint 50 times, p50 and p95, to the first byte and to the last. Reads
  with `--key` bypass the cache and cross every hop (Worker, container, D1); anonymous reads show the
  cache (`X-Quaso-Cache: hit`).
- **Cold starts:** add `--cold-starts 3 --sleep 660`. It waits 11 minutes (longer than `sleepAfter`)
  before each `/healthz`, which is never cached.

Run it from where your team works, and against a Docker Compose instance for comparison.

## Local runs

`deno task cf:dev` runs the Worker and the container on your machine with Wrangler, on Wrangler's
local D1 and R2 (Docker must be running; the first run builds the image from `deploy/Dockerfile` for
`linux/amd64`, which is slow on other machines). Copy `packages/cloudflare/.dev.vars.example` to
`packages/cloudflare/.dev.vars` and fill in `SECRET_KEY`. Then open <http://localhost:8787>.

`deno task cf:test` runs the package's tests in `workerd`, without Docker or an account.

## Troubleshooting

- **`error code: 1101` or a bare 500 from the Worker:** the Worker threw. Watch its exceptions
  while you repeat the request:
  ```sh
  cd packages/cloudflare
  deno run -A npm:wrangler tail quaso-production --format json
  ```
- **The server's own logs** (its JSON lines, including startup and migrations): the Cloudflare
  dashboard, Workers & Pages, the Worker, Logs. With an API token, they need Workers Observability
  Read.
- **"Quaso is starting up or unavailable" (503) for more than two minutes:** the container didn't
  start. Its state is on the dashboard's Containers page; the server's logs say why,
  such as a missing secret.
- **A new hostname doesn't resolve on your machine** although the deploy finished: a lookup made
  before the Custom Domain existed stays cached as "no such name" for the zone's negative TTL, 30
  minutes on Cloudflare. Try it from another network, or wait.
- **The first deploy waits a long time for `/healthz`:** Cloudflare issues the Custom Domain's
  certificate and pulls the image on the first start. Later deploys are quicker.

## Limits to know

- **One container** (`max_instances: 1`). One game's traffic is far below what it handles.
- **Request bodies:** an upload of 50 MB of JSON is the most the server takes.
- **The cache** keeps anonymous API reads for their `Cache-Control` time (30 seconds), and serves
  them stale for a while as it refreshes them. Signed-in requests and API keys always reach the
  server. The website's hashed files are kept by browsers for a year; its page is checked for a
  new version on every visit.
