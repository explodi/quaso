# Backups, restores and upgrades

Back up Quaso, test restoration, and keep the data and code together during upgrades. Each instance
has one database and one server that writes to it. Keep a tested backup outside the machine or
account that hosts it, and record the exact image version. Instance signing keys and address-hashing
salts are generated in the database and left out of downloaded backups. Portable restores keep the
destination instance’s credentials; passwords do not depend on them. The
[Docker guide](deploy-docker.md) and [Cloudflare guide](deploy-cloudflare.md) contain deployment and
recovery commands.

## Backups

A portable backup is a file you can import into either local or Cloudflare storage. Automatic
backups depend on the storage type:

| Setup                  | Automatic backup                                        | Retention                                                                                                                        | Manual copy                                           |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Docker / local storage | Hourly SQLite objects under `backups/` in `/data/store` | Every copy for 48 hours, then the newest copy per UTC day for the configured window (default 30 days); pre-migration copies stay | Settings → Backups, or copy all `/data` while stopped |
| Cloudflare storage     | gzip JSON in R2 at 03:00 UTC                            | Settings → History & retention, default 30 days                                                                                  | Settings → Backups, or download an R2 object          |

**Settings → Backups** offers SQLite and JSON downloads in both setups. Local snapshots use SQLite's
backup API on a separate connection, so a copy is consistent while requests continue. Cloudflare
exports are read in chunks; another write during the export starts it again. After three attempts a
download returns 503; try during a quiet period. A failed nightly R2 export retries an hour later.

Downloaded backups leave out provider credential values. They retain only the names of configured
keys, so restore can list the credentials to enter again. **Settings** shows that notice and offers
masked key replacement in its **AI translation** and **Email delivery** sections. Re-entering a key
clears its notice. Local scheduled snapshots, copies extracted with `quaso backup`, and a stopped
copy of the Docker volume retain secret values. Protect them as you protect the live database. A
portable restore still leaves out those source credentials; enter the provider keys again in the
destination.

Local retained copies can be downloaded by a signed-in administrator through
`GET /api/v1/backup?at=2026-10-02T00:00Z`. It selects the newest retained SQLite copy at or before
that time; the default response is SQLite. Add `format=json` for a portable JSON document.
`file=backups/pre-migration-v1-to-v2-20261002T000000Z.sqlite` selects a particular pre-migration
copy instead. The store's physical objects include metadata, so use this download route to obtain
the SQLite file for `quaso restore`. With access to local storage,
`quaso backup --at 2026-10-02T00:00Z /data/recovery.sqlite` extracts a copy without opening the live
database. This also works after a failed upgrade. Use `quaso backup <store-key> <file>` for a named
pre-migration copy. Both refuse to overwrite an existing output file.

Backup files include accounts, roles, hashed API keys, translations, history, settings and jobs.
Portable restores leave out sessions and temporary sign-in tokens, so people sign in again.
Passwords and API keys keep working: they don't depend on the instance's keys.

## Restore drills and moving between setups

Run a drill on a separate hostname and empty storage. Never practice on production data in place.

1. Record the source version, schema version, string and language counts, and last backup time from
   **Admin**. Download translations and `quaso status --json` with a read key as a baseline.
2. Download a SQLite or JSON backup from Settings. For Cloudflare, also exercise the R2 download
   shown in its deployment guide.
3. Create the empty destination using the same or a newer compatible release. Do not claim it or
   upload strings before restoring.
4. For Docker, follow the new-volume `quaso restore <file>` drill in the
   [Docker guide](deploy-docker.md#backups-and-a-restore-drill). For Cloudflare, use the
   [`cf:restore --file` command](deploy-cloudflare.md#backups-and-recovery) with the setup key.
5. Sign in, compare status, downloads, roles and history. Verify a new edit and download on the
   destination. Keep every command pointed at the drill hostname.
6. Repeat Docker → Cloudflare and Cloudflare → Docker when both are in use. SQLite, JSON and gzip
   JSON are portable across the two storage implementations.
7. Record backup age, restored version, elapsed recovery time, comparisons and any failure. Stop the
   drill instance after checking it. Repeat after schema or backup configuration changes.

`POST /restore` (and so `cf:restore --file`) takes backup files up to 1 GiB. Any restore reads at
most 512 MiB of JSON, after decompressing a gzip backup: the largest string the server can parse.
A bigger document is refused with 413 `payload_too_large`; use a SQLite backup instead.

A restore rejects a destination with strings or assigned roles. An interrupted restore may be
retried before anything else writes there. If the destination was used meanwhile, start with another
empty instance. A backup from a newer schema requires a newer Quaso release.

Cloudflare's D1 Time Travel is separate from portable restore. It rewinds the deployed database in
place within the Workers Paid plan's 30-day history:
`deno task cf:restore --env production --at <UTC time>`. The command pauses the instance and stops
the container first, and prints a bookmark that undoes the restore. Check health and the restored
data afterwards. A drill belongs on staging; local D1 cannot time travel. Writes after the selected
time disappear, including changes to credentials and sessions. R2 is not rewound, and file cleanup
might already have removed objects referenced by the restored database. Test file downloads too. See
[Cloudflare's Time Travel reference](https://developers.cloudflare.com/d1/reference/time-travel/).

## Upgrades and rollbacks

For Docker, pin the target image version, then:

```sh
docker compose pull
docker compose up -d
docker compose logs --tail 100 quaso
curl --fail https://translate.example.com/healthz
```

Local storage takes a pre-migration snapshot before changing the schema. Retain that snapshot and
the previous image. To roll back, stop the server, restore the snapshot into a new volume with the
previous image, then switch the deployment to it. Keep the newer volume for investigating and
recovering later writes. Never run an older image against an upgraded database.

For Cloudflare, test staging and retain a portable backup, source commit, image and pre-upgrade UTC
time. Use the new release's source checkout and matching `image` in `quaso.cloudflare.jsonc`, then
run `deno task cf:deploy --env production`. The checkout supplies the Worker and website; the image
supplies the server. Wrangler activates the Worker before updating the container, so deployment can
fail after the new Worker is live. See
[Cloudflare's deployment order](https://developers.cloudflare.com/containers/guides/deploy/). Schema
migrations only move forwards. The controller restarts a server from an earlier deployment on a
quiet request once the server is no longer busy; jobs and exports can delay this. Verify the chosen
version in `/healthz` after deployment, including after changes to Worker secrets.

For a Cloudflare schema rollback, use a separate empty deployment on the previous tested source and
image. Import the pre-upgrade backup, compare the data and downloads, then move clients to the
recovered instance. Stop writes to the failed deployment during the switch and keep its data for
recovery of later work.

`cf:restore --at` resumes the currently deployed container image. It does not coordinate a schema
downgrade with an image change. Deploying an old image before restoring can expose it to the newer
schema; restoring first can let the newer image migrate the data again. Use in-place Time Travel
only when the running release supports the restored schema. Record which later writes were lost.

## Monitoring

Check these signals to detect problems:

- `/healthz` reports the server version, storage mode, schema version, data revision and work state.
  A failed storage connection returns 503. Probe it from outside your deployment; the Docker health
  check probes the process locally. `busy` is true while translation, publication or backup work is
  running. `nextWakeUp` is the next alarm time in milliseconds since the Unix epoch, or `null` when
  none is scheduled. Published file history defaults to 90 days. Daily maintenance keeps current
  versions and removes expired history and unreferenced version objects older than a day.
- Admin shows version, database, recent errors, LLM jobs, Gemini configuration and last backup. A
  configured key is not proof that the provider currently accepts it; check failed jobs too.
- Quaso writes structured JSON logs. `docker compose logs --tail 100 quaso` is the first check on a
  VM. Keep logs in your existing log system with limited retention and access.
- Cloudflare has Workers Logs enabled in `wrangler.jsonc`. From `packages/cloudflare`, use
  `deno run -A npm:wrangler tail quaso-production`. If you chose another Worker name, use it here.
  Check both Worker and container failures.
- Alert when health fails, backups become stale, disk space is low, or jobs keep failing/pausing.

The local `quaso.lock` uses an operating system lock, released on normal exit or a crash. A second
process gets “Another Quaso server is using …”. Stop the owner; deleting the file while a process
holds it is unsafe.

## Performance expectations

Measure the deployment with data and traffic like your own. The repository includes local storage
and Cloudflare runtime tests, but their results do not predict network delay, Gemini response time,
or the wait for a sleeping container to start.

Use `scripts/measure.ts` from the regions where contributors work; the
[Cloudflare guide](deploy-cloudflare.md#measure-it) describes its options. It works against Docker
Compose too. Run `QUASO_SMOKE=1 deno task test` for the larger local data test. Record the source
commit, server image, data size, location and conditions with each result before using it to choose
hardware or set alert limits.

## Keys and access

Each instance generates the key that signs its session cookies, and keeps it in its database.
Passwords are hashed with a salt of their own and API keys are hashed, so neither depends on that
key: a restore into another instance keeps both working, and only ends sessions.

For account recovery, use password reset. Email sign-in links require an already verified address.
Resetting an unverified account verifies its email, removes previously linked OAuth identities,
replaces the password and revokes its old sessions. A reset on an already verified account keeps its
linked identities. All cookie-authenticated changes, private reads and OAuth flows recheck the
session in storage, so revocation takes effect on their next request. Public reads can use a signed
cookie without a fresh session lookup. Their access does not grant permission to change data.

Give download jobs read keys and upload jobs upload keys. Create one named key per integration, save
its secret once in your CI secret store, and revoke it in Settings when no longer needed. A key
created in the website follows its creator's current role and language limits, so create CI upload
keys with an administrator account. The server caches API-key identity lookups for up to one minute,
but service permission checks read the current key record and reject revoked keys.

Keep the initial setup key private and claim an instance promptly. Require HTTPS, keep development
login disabled publicly, restrict administrator roles, install supported image updates and keep
backups encrypted or access-controlled. See [configuration](configuration.md) for proxy and CORS
settings.

## Coming from 1.0.0-rc.1

1.0.0-rc.2 has a rewritten initial schema and no upgrade path from 1.0.0-rc.1. Its restore commands
reject 1.0.0-rc.1 SQLite, JSON and compressed JSON backups. Start a fresh instance and import the
translation files instead. For local development, use `deno task dev:reset` to replace old
development data.
