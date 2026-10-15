# Deploy with Docker Compose

Run Quaso on a Linux virtual machine (VM) with Docker Compose. The supplied files run the server,
store its data in a Docker volume, and use Caddy to serve it over HTTPS.

Before you start, install git, Docker Engine and its Compose plugin. You need a public address and a
hostname you control. Allow inbound TCP ports 80 and 443; UDP port 443 is optional for HTTP/3. Keep
port 8000 private when Caddy receives public traffic. Replace `translate.example.com` in this guide
with your hostname.

These instructions describe the current `main` branch. They use its source checkout and the image
built from the same commit. For a tagged release, use the documentation in that release's checkout.
The [quick start](README.md) continues from deployment to your first translation files.

## Five steps

1. Point your domain's DNS A record at the VM's IPv4 address. If you add an AAAA record, its IPv6
   address must reach the same VM. Wait until your hostname resolves correctly.
2. Get the source and prepare the deployment files:

   ```sh
   git clone --branch main 'https://github.com/explodi/quaso.git'
   cd quaso/deploy
   cp .env.example .env
   chmod 600 .env
   QUASO_IMAGE="explodi/quaso:sha-$(git rev-parse --short=7 HEAD)"
   printf '%s\n' "$QUASO_IMAGE"
   ```

   In `compose.yaml`, replace `image: explodi/quaso:latest` with the image printed above. The
   `sha-<commit>` tag selects the build for that source commit; `latest` follows `main` as it
   changes. Wait for the commit's **Docker image** workflow to publish successfully before pulling
   it. If the image is not published, wait for publication or set `image: quaso:local` and run
   `docker compose build quaso` from this checkout. When using that local image, skip the pull
   command for Quaso in the next step and pull Caddy with `docker compose pull caddy`.

3. Edit `.env`. Set `QUASO_DOMAIN=translate.example.com` and `SETUP_KEY` to the output of
   `openssl rand -hex 16`. Keep `TRUST_PROXY=true`, because Caddy forwards requests to Quaso. After
   creating the administrator, enter a Gemini API key in **Settings → AI translation** if you want
   machine translation. Without a key, you can translate and review by hand. The
   [configuration reference](configuration.md) describes the remaining settings.
4. Start the containers:

   ```sh
   docker compose pull
   docker compose up -d --no-build
   ```

5. Open `https://translate.example.com/setup`, enter your setup key, and create the first
   administrator. Keep the key private until setup is complete; you can then remove it from `.env`.
   Configure the project and languages in **Settings**, then check the server:

   ```sh
   curl --fail https://translate.example.com/healthz
   ```

   Expect `ok: true` and `storage: "local"` in the JSON response. Next,
   [connect your game's repository](add-to-your-game.md).

## What runs and where data lives

Caddy obtains and renews the HTTPS certificate and proxies requests to Quaso. Quaso is one compiled
Deno application serving the API and website. Its image runs as user 65532. The supplied Compose
file makes its root filesystem read-only. The named `quaso-data` volume is mounted at `/data`,
containing `quaso.sqlite` and its write-ahead log, `quaso.lock`, and `store/`, which holds the
published files and the backups. Compose prefixes volume names with the deployment directory or
project name. Caddy has separate certificate and configuration volumes. Never run
`docker compose down -v` against data you want to keep.

Without Compose, prepare `.env` with `SETUP_KEY` as described above, and use an existing reverse
proxy for HTTPS. Use `QUASO_IMAGE` from the checkout step above:

```sh
docker run -d --name quaso --restart unless-stopped \
  -p 127.0.0.1:8000:8000 -v quaso-data:/data \
  --env-file .env \
  -e PUBLIC_URL=https://translate.example.com \
  "$QUASO_IMAGE"
```

The loopback binding lets a proxy on this VM reach Quaso. Set `TRUST_PROXY=true` only when a trusted
proxy is the only route to the server. Configure HTTPS on that proxy before opening setup.

## API keys

Once the instance is running, follow [From your repository to every language](workflow.md) to
connect your game and run the translation workflow, or
[Migrate from Crowdin](migrate-from-crowdin.md) to bring existing translations and their proofread
state.

An administrator creates a named key in **Settings → API keys**, and everyone signed in can create
their own on their account page. Use `read` for downloads and status; use `upload` for uploads,
imports and LLM runs. The secret is shown once. A key created in the website is limited by its
creator’s current role and assigned languages as well as its scope. Create CI upload keys with an
administrator account.

The following commands use the server binary inside the image, which has different commands from the
npm CLI. For recovery without the website, stop the server before creating a key:

```sh
docker compose stop quaso
docker compose run --rm quaso token create --name ci --scope upload
docker compose up -d quaso
```

`docker compose exec quaso /app/quaso token create …` cannot open local storage while the running
server holds its lock.

## Upgrades and rollback

Read the release notes and retain a backup and the current image's exact version or digest. Test a
restore before a major upgrade. Pin the desired image version in `compose.yaml`, then run:

```sh
docker compose pull
docker compose up -d
docker compose logs --tail 100 quaso
curl --fail https://translate.example.com/healthz
```

The database migrates on startup. Before changing a supported schema, Quaso writes a store object
named `backups/pre-migration-vN-to-vM-TIMESTAMP.sqlite`. Those snapshots are not rotated by
scheduled retention. Migrations only move forwards. An older image cannot use a newer schema. The
[1.0.0-rc.1 data format](operations.md#coming-from-100-rc1) has no upgrade path.

To roll back, choose the snapshot from before the upgrade and copy it out while the container is
stopped. Use the current image to extract it before changing image versions. Replace the sample key
with the one recorded in the migration log. Extraction does not open the live database, so it works
even when that database cannot start:

```sh
docker compose stop quaso
SNAPSHOT=backups/pre-migration-v1-to-v2-20261001T030000Z.sqlite
docker compose run --rm quaso backup "$SNAPSHOT" /data/rollback.sqlite
docker compose cp quaso:/data/rollback.sqlite ./rollback.sqlite
docker compose down
mkdir rollback
cp compose.yaml Caddyfile .env rollback/
cp rollback.sqlite rollback/
cd rollback
```

Edit the copied `compose.yaml` to use the previous image version. Restore into a new named volume
and start it:

```sh
docker compose -p quaso-rollback run --rm -v "$PWD/rollback.sqlite:/rollback.sqlite:ro" quaso restore /rollback.sqlite
docker compose -p quaso-rollback up -d
```

The previous deployment's volumes remain untouched; `down` without `-v` preserves them. Stopping its
Caddy also frees ports 80/443 for the replacement. Check health, sign-in and downloaded files before
resuming writes. Writes made since the snapshot are missing; retain the newer volume for recovery.

## Backups and a restore drill

Scheduled SQLite copies go under the store's `backups/` prefix in `/data/store` every hour. Copies
less than 48 hours old are kept. Older copies are reduced to the newest per UTC day, within the
window set in **Settings → History & retention** (30 days by default). Pre-migration copies are kept
separately. Copy backups off the VM: the volume alone does not protect against a lost VM.

To retrieve a retained copy, sign in as an administrator and download
`/api/v1/backup?at=2026-10-02T00:00Z`. This returns the newest copy at or before that time, as a
SQLite file usable by `quaso restore`. The store's physical object files include metadata and should
be copied as part of the whole volume, rather than opened as SQLite. The server command
`quaso backup --at 2026-10-02T00:00Z /data/recovery.sqlite` also extracts a retained copy without
starting or migrating the database. Unlike a website download, this extract preserves the stored
secrets. It refuses an existing output file. `quaso backup <store-key> <file>` extracts a named
scheduled or pre-migration copy.

Administrators can download SQLite or JSON backups from **Settings → Backups** while Quaso runs. You
can also copy the whole `/data` directory while Quaso is stopped. A backup download contains
accounts, password hashes and hashed API keys, so protect it like the live database. It leaves out
the Gemini and email API keys: after a restore, Settings lists them to enter again.

Practice this on a separate, empty instance:

1. Download a backup as `backup.sqlite`. Record `quaso status --json` and save downloaded
   translation files for comparison.
2. Use the same or a newer compatible Quaso image on a separate test VM. Copy the three deployment
   files and `backup.sqlite` to its deployment directory. Set a different hostname in `.env`. Ensure
   user 65532 can read the backup file mounted in the next step.
3. Restore before claiming the new instance. An explicit project name gives it a new volume:

   ```sh
   docker compose -p quaso-drill run --rm \
     -v "$PWD/backup.sqlite:/backup.sqlite:ro" quaso restore /backup.sqlite
   docker compose -p quaso-drill up -d
   ```

4. Check `/healthz`, sign in with an existing account, compare status and downloads, check history,
   and make an edit on the drill instance. Use its hostname for every CLI command.
5. Stop the drill with `docker compose -p quaso-drill down`. Record the backup date, version,
   results, elapsed recovery time and any manual steps. Repeat after changes to backup or deployment
   settings.

The server subcommand is `quaso restore <file>`; it accepts `.sqlite`, `.json` and `.json.gz` and
refuses a destination with strings or assigned roles. People sign in again because restores leave
out sessions; their passwords and API keys keep working. Older supported schemas are migrated; newer
schemas require upgrading the restoring image first. The 1.0.0-rc.1 format is not supported. If a
restore is interrupted, retry before using that destination. See [operations](operations.md) for
cross-storage drills.

## Troubleshooting

- Start with `docker compose logs --tail 100 quaso caddy` and `docker compose ps`.
- `/healthz` returns JSON with the version and storage mode. Docker runs `/app/quaso healthcheck`
  against the local HTTP port. A successful health check does not verify a Gemini credential.
- “Another Quaso server is using /data” means a process holds the operating system lock. Stop the
  other instance. Do not delete `quaso.lock`: the kernel releases the lock when its owner exits,
  including after a crash.
- For a bind mount, give user/group 65532 write access to its directory. A named volume normally
  inherits the image's ownership. Check disk space and permissions when snapshots or startup fail.
- If HTTPS fails, check DNS, inbound ports 80/443 and Caddy's logs. Do not publish a broken AAAA
  record.
