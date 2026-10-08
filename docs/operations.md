# Backups, restores and upgrades

An instance has one database and one writer. Keep a tested backup outside the machine or account
that hosts it and record the exact image version. Instance signing keys and address-hashing
salts are generated in the database and omitted from downloaded backups. Restores preserve
the destination instance’s credentials; passwords do not depend on them. The
[Docker guide](deploy-docker.md) and [Cloudflare guide](deploy-cloudflare.md) contain deployment and
recovery commands.

## Backups

| Setup                  | Automatic backup                                        | Retention                                                                                                                        | Manual copy                                           |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Docker / local storage | Hourly SQLite objects under `backups/` in `/data/store` | Every copy for 48 hours, then the newest copy per UTC day for the configured window (default 30 days); pre-migration copies stay | Settings → Backups, or copy all `/data` while stopped |
| Cloudflare storage     | gzip JSON in R2 at 03:00 UTC                            | Settings → Retention, default 30 days                                                                                            | Settings → Backups, or download an R2 object          |

Settings offers SQLite and JSON downloads in both setups. Local snapshots use SQLite's backup API on
a separate connection, so a copy is consistent while requests continue. Cloudflare exports are read
in chunks; a concurrent write restarts the export. After three attempts a download returns 503; try
during a quiet period. A failed nightly R2 export retries an hour later.

Downloaded backups omit provider credential values. They retain only the names of configured
keys, so restore can list the credentials to enter again. Settings shows that notice and offers
masked key replacement in its LLM and Email sections. Re-entering a key clears its notice.
A stopped copy of the Docker volume retains the secret values on the operator's own disk.

Local retained copies can be downloaded by a signed-in administrator through
`GET /api/v1/backup?at=2026-10-02T00:00Z`. It selects the newest retained SQLite copy at or
before that time; the default response is SQLite. Add `format=json` for a portable JSON
document. `file=backups/pre-migration-v1-to-v2-20261002T000000Z.sqlite` selects a particular
pre-migration copy instead. The store's physical objects include metadata, so use this
download route to obtain the SQLite file for `quaso restore`.
With access to local storage, `quaso backup --at 2026-10-02T00:00Z /data/recovery.sqlite`
extracts a copy without opening the live database. This also works after a failed upgrade.
Use `quaso backup <store-key> <file>` for a named pre-migration copy. Both refuse to
overwrite an existing output file.

Backups include accounts, roles, API keys, translations, history, settings and jobs. Portable
restores omit sessions and transient authentication tokens. Users sign in again. Passwords need the
original `SECRET_KEY`; store the key separately from the backup. Do not rely on sessions surviving a
restore.

## Restore drills and moving between setups

Run a drill on a separate hostname and empty storage. Never rehearse on production data in place.

1. Record the source version, schema, string/language counts and last backup time from Admin.
   Download translations and `quaso status --json` with a read key as a baseline.
2. Download a SQLite or JSON backup from Settings. For Cloudflare, also exercise the R2 download
   shown in its deployment guide. Verify that you can retrieve the original secret key.
3. Create the empty destination using the same or a newer release. Set the source `SECRET_KEY`. Do
   not claim it or upload strings before restoring.
4. For Docker, follow the new-volume `quaso restore <file>` drill in the
   [Docker guide](deploy-docker.md#backups-and-a-restore-drill). For Cloudflare, use the
   [setup-token restore route or remote restore command](deploy-cloudflare.md#backups-and-recovery).
5. Sign in, compare status, downloads, roles and history. Verify a new edit and download on the
   destination. Keep every command pointed at the drill hostname.
6. Repeat Docker → Cloudflare and Cloudflare → Docker when both are in use. SQLite, JSON and gzip
   JSON are portable across the two storage implementations.
7. Record backup age, restored version, elapsed recovery time, comparisons and any failure. Stop the
   drill instance after checking it. Repeat after schema or backup configuration changes.

A restore rejects a destination with strings or assigned roles. An interrupted restore may be
retried before anything else writes there. If the destination was used meanwhile, start with another
empty instance. A backup from a newer schema requires a newer Quaso release.

Cloudflare point-in-time recovery is separate from portable restore. On a deployed Durable Object,
it rewinds storage to a timestamp in the recovery window. Pause writes, record the current UTC time,
then use the internal `pitr` request in the Cloudflare guide. It restarts the object. Check health
and the restored data, then resume traffic. A rehearsal belongs on staging; local workerd cannot
perform PITR. All writes after the selected time disappear.

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
previous image and the same key, then switch the deployment to it. Keep the newer volume for
investigating and recovering later writes. Never run an older image against an upgraded database.

For Cloudflare, test staging and retain a portable backup and a pre-upgrade UTC timestamp. Deploy
the chosen source checkout with `deno task cf:deploy --env production`. The rollout is **not
transactional**: Wrangler activates the Worker before all containers run the new image. The internal
API accepts the previous version so that this overlap works. Schema migrations only move forwards.

To roll back Cloudflare, stop traffic and translation jobs, return to the previous tested source
checkout, deploy that version and recover the database to its pre-upgrade state using PITR. If PITR
is unavailable, restore the pre-upgrade export into a separate empty deployment on the previous
version and switch the hostname after verification. Rewinding code alone cannot undo schema changes.
Record which later writes were lost and keep a backup of the newer state before recovery.

## Monitoring

- `/healthz` reports the version, schema/storage health and setup. A failed storage connection
  returns 503. Probe it from outside your deployment; the Docker health check probes the process
  locally.
  `busy` is true while translation, publication or backup work is running. `nextWakeUp` is the
  next alarm time in milliseconds since the Unix epoch, or `null` when none is scheduled.
  Published file history defaults to 90 days. Daily maintenance keeps current versions
  and removes expired history and unreferenced version objects older than a day.
- Admin summarizes version, database, recent errors, LLM jobs, Gemini configuration and last backup.
  A configured key is not proof that the provider currently accepts it; inspect failed jobs too.
- Quaso writes structured JSON logs. `docker compose logs --tail 100 quaso` is the first check on a
  VM. Keep logs in your existing log system with limited retention and access.
- Cloudflare has Workers Logs enabled in `wrangler.jsonc`. From `packages/cloudflare`, use
  `deno run -A npm:wrangler tail --env production`. Check both Worker and container failures.
- Alert when health fails, backups become stale, disk space is low, or jobs keep failing/pausing.

The local `quaso.lock` uses an operating system lock, released on normal exit or a crash. A second
process gets “Another Quaso server is using …”. Stop the owner; deleting the file while a process
holds it is unsafe. Remote storage has no local lock or snapshots.

## Performance expectations

These are development measurements, not hosted-service guarantees. With local SQLite, 3,000 strings
in 10 languages took about 60 ms to upload, 50 ms to download and 25 ms for status. The larger
50,000-string / 30-language smoke run on 2026-10-01 took 577 ms to upload, 901 ms to upload changed
sources, 304 ms for an unchanged upload, 2.35 seconds to download 1,500 files and 1.14 seconds for
status. With the LLM provider enabled, large uploads measured about 1.5 seconds. Ten-language
translation using a fake provider with 300 ms requests completed in about a second; that does not
measure Gemini quality or latency.

The local workerd performance case uses real Durable Object SQLite with 3,000 strings, ten
languages, 30,000 translations and 100 exported files. Its complete test took 263 ms in the same
development run; each upload, export and browsing operation stayed within its 30-second budget. This
is a local storage check, not a deployed Cloudflare network or cold-start measurement.

Actual Gemini latency, cold starts and distance to Cloudflare storage vary. Use `scripts/measure.ts`
from the regions your contributors use; its command and cold-start options are in the Cloudflare
guide. Run `QUASO_SMOKE=1 deno task test` for the large local dataset. Measure production-sized data
before choosing hardware or setting alert thresholds.

## Secret rotation and access

Changing `SECRET_KEY` invalidates signed sessions **and password hashes**. Everyone must sign in
again; password users need password resets. Plan working email delivery or administrator reset links
before rotation. Preserve the old key for old backups, and test recovery with it. Rotate only as an
intentional maintenance operation; replacing a lost secret with a random value does not recover
users.

For account recovery, use password reset. Email sign-in links require an already verified address.
Resetting an unverified account verifies its email, removes previously linked OAuth identities,
replaces the password and revokes its old sessions. A reset on an already verified account keeps its
linked identities. All cookie-authenticated changes, private reads and OAuth flows recheck the
session in storage, so revocation takes effect on their next request. Only public project reads may
trust a signed cookie for the rest of its one-hour lifetime.

Give download jobs read keys and upload jobs upload keys. Create one named key per integration, save
its secret once in your CI secret store, and revoke it in Settings when no longer needed. API-key
authentication may be cached for up to one minute. Keep `SERVICE_TOKEN` private between the server
and Worker and rotate both ends together. Do not expose internal API credentials to game clients.

Keep the initial setup key private and claim an instance promptly. Require HTTPS, keep development
login disabled publicly, restrict administrator roles, install supported image updates and keep
backups encrypted or access-controlled. See [configuration](configuration.md) for proxy and CORS
settings.

## Beta 2 starts fresh

Beta 2 has a rewritten initial schema and no upgrade path from 1.0.0-rc.1. Its restore
commands reject Beta 1 SQLite, JSON and compressed JSON backups. Start a fresh instance
and import the translation files instead. For local development, use `deno task dev:reset`
to replace old development data.
