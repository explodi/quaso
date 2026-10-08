# Deploy with Docker Compose

Quaso runs on a Linux VM with Docker Engine and the Compose plugin installed. Give the VM a public
address and a hostname you control. Allow inbound TCP ports 80 and 443; UDP 443 is optional for
HTTP/3. Do not expose port 8000 when Caddy is the public entry point.

Throughout these guides, replace `<org>` with the organization publishing your Quaso image and
repository. The package name `@quaso/cli` must be reserved before the first public release. Until
images are published, build from a checkout with `deno task docker`, and use `quaso:dev` as the
image.

## Five steps

1. Point your domain's DNS A record at the VM's IPv4 address. If you add an AAAA record, its IPv6
   address must reach the same VM. Wait until your hostname resolves correctly.
2. Copy `compose.yaml`, `Caddyfile` and `.env.example` from the repository's `deploy/` directory
   into an empty deployment directory on the VM. Rename `.env.example` to `.env`:

   ```sh
   mkdir quaso
   cd quaso
   curl -L 'https://raw.githubusercontent.com/<org>/quaso/main/deploy/compose.yaml' -o compose.yaml
   curl -L 'https://raw.githubusercontent.com/<org>/quaso/main/deploy/Caddyfile' -o Caddyfile
   curl -L 'https://raw.githubusercontent.com/<org>/quaso/main/deploy/.env.example' -o .env
   chmod 600 .env
   ```

   `compose.yaml` uses the official image, `explodi/quaso:latest` on Docker Hub, which follows the
   main branch. To pin a release, use its version, such as `explodi/quaso:1.0.0-rc.1`; the `:1`
   alias is created only for stable releases. The `build` section is for a source checkout; using
   the published image does not need it.

3. Edit `.env`. Set `QUASO_DOMAIN=translate.example.com` and `SETUP_KEY` to the output of
   `openssl rand -hex 16`. Keep `TRUST_PROXY=true`, since Caddy is
   in front. After creating the administrator, enter the Gemini API key in Settings → LLM
   translation. Without a key you can translate and review by hand. The
   [configuration reference](configuration.md) describes the remaining settings.
4. Start the containers:

   ```sh
   docker compose up -d
   ```

5. Open `https://translate.example.com/setup`, enter your setup key, and create the first
   administrator. Keep the key private until setup is complete; you can then remove it from
   `.env`. Configure the project and languages in Settings, then
   [connect your game's repository](add-to-your-game.md).

## What runs and where data lives

Caddy obtains and renews the HTTPS certificate and proxies requests to Quaso. Quaso is one compiled
Deno application serving the API and website. Its image runs as user 65532 on a read-only root
filesystem. The named `quaso-data` volume is mounted at `/data`, containing `quaso.sqlite`, its WAL,
`secret-key` when generated locally, `quaso.lock`, and `backups/`. Compose prefixes volume names
with the deployment directory or project name. Caddy has separate certificate and configuration
volumes. Never run `docker compose down -v` against data you want to keep.

Without Compose, use an existing reverse proxy for HTTPS:

```sh
docker run -d --name quaso --restart unless-stopped   -p 127.0.0.1:8000:8000 -v quaso-data:/data   -e PUBLIC_URL=https://translate.example.com   'explodi/quaso:1'
```

The loopback binding lets a proxy on this VM reach Quaso. Set `TRUST_PROXY=true` only when a trusted
proxy is the only route to the server. TLS is the operator's responsibility with this command.

## API keys

Once the instance is running, follow [From your repository to every language](workflow.md)
to connect your game and run the translation workflow, or [Migrate from Crowdin](migrate-from-crowdin.md)
to bring existing translations and their proofread state.

An administrator creates a named key in **Settings → API keys**. Use `read` for downloads and
status; use `upload` for uploads, imports and LLM runs. The secret is shown once.

For recovery without the website, stop the local server before creating a key:

```sh
docker compose stop quaso
docker compose run --rm quaso token create --name ci --scope upload
docker compose up -d quaso
```

`docker compose exec quaso /app/quaso token create …` cannot open local storage while the running
server holds its lock. With Cloudflare storage the command can run alongside the server.

## Upgrades and rollback

Read the release notes and retain a backup and the current image's exact version or digest. Test a
restore before a major upgrade. Pin the desired image version in `compose.yaml`, then run:

```sh
docker compose pull
docker compose up -d
docker compose logs --tail 100 quaso
curl --fail https://translate.example.com/healthz
```

The database migrates on startup. Before any migration Quaso writes a store object named
`backups/pre-migration-vN-to-vM-TIMESTAMP.sqlite`. Those snapshots are not rotated by
scheduled retention. Migration is forward-only: changing back to an older image alone is insufficient.

To roll back, choose the snapshot from before the upgrade and copy it out while the container is
stopped. Replace the sample key with the one recorded in the migration log. Extraction
does not open the live database, so it works even when that database cannot start:

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

Edit the copied `compose.yaml` to use the previous image version. Put the original `SECRET_KEY` in
its `.env`, including the generated key if the original environment left it empty. Restore into a
new named volume and start it:

```sh
docker compose -p quaso-rollback run --rm -v "$PWD/rollback.sqlite:/rollback.sqlite:ro" quaso restore /rollback.sqlite
docker compose -p quaso-rollback up -d
```

The previous deployment's volumes remain untouched; `down` without `-v` preserves them. Stopping its
Caddy also frees ports 80/443 for the replacement. Check health, sign-in and downloaded files before
resuming writes. Writes made since the snapshot are absent; retain the newer volume for recovery.

## Backups and a restore drill

Scheduled SQLite copies go under the store's `backups/` prefix in `/data/store` every hour.
Every copy is kept for 48 hours, then the newest copy per UTC day for 30 days. Pre-migration
copies are kept separately. Copy backups off the VM: the volume alone does not protect against a lost VM.

To retrieve a retained copy, sign in as an administrator and download
`/api/v1/backup?at=2026-10-02T00:00Z`. This returns the newest copy at or before that time,
as a SQLite file usable by `quaso restore`. The store's physical object files include
metadata and should be copied as part of the whole volume, rather than opened as SQLite.
The server command `quaso backup --at 2026-10-02T00:00Z /data/recovery.sqlite` also extracts
a retained copy without starting or migrating the database. It refuses an existing output
file. `quaso backup <store-key> <file>` extracts a named scheduled or pre-migration copy.

Administrators can download SQLite or JSON backups from **Settings → Backups** while Quaso runs. You
can also copy the whole `/data` directory while Quaso is stopped. Keep the original `SECRET_KEY`
with your backup, separately and securely: it is needed for existing passwords. A backup download
contains account data and API keys, so protect it like the live database.

Practice this on a separate, empty instance:

1. Download a backup as `backup.sqlite`, and retain the original `SECRET_KEY` (or
   `/data/secret-key`). Record `quaso status --json` and save downloaded translation files for
   comparison.
2. Use the same or a newer Quaso image on a separate test VM. In its deployment directory copy the
   three deployment files, use a different hostname, and set the original `SECRET_KEY` in its
   `.env`.
3. Restore before claiming the new instance. An explicit project name gives it a new volume:

   ```sh
   docker compose -p quaso-drill run --rm      -v "$PWD/backup.sqlite:/backup.sqlite:ro" quaso restore /backup.sqlite
   docker compose -p quaso-drill up -d
   ```

4. Check `/healthz`, sign in with an existing account, compare status and downloads, inspect
   history, and make an edit on the drill instance. Use its hostname for every CLI command.
5. Stop the drill with `docker compose -p quaso-drill down`. Record the backup date, version,
   results, elapsed recovery time and any manual steps. Repeat after changes to backup or deployment
   settings.

The server subcommand is `quaso restore <file>`; it accepts `.sqlite`, `.json` and `.json.gz` and
refuses a nonempty destination. People sign in again because restores omit sessions. Older schemas
are migrated; newer schemas require upgrading the restoring image first. If a restore is
interrupted, retry before using that destination. See [operations](operations.md) for cross-storage
drills.

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
