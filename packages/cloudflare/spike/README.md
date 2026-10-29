# Measure Cloudflare container behavior

Use this temporary test deployment to measure container startup, database access and shutdown. It
creates Cloudflare resources in the signed-in account. You need Docker, the repository dependencies
and a Cloudflare account with Containers enabled. Sign in with Wrangler first and choose names that
do not match any existing deployment. Store measurements in the ignored `.quaso/beta-2-evidence/`
folder.

Create the resources from `packages/cloudflare` with
`npx wrangler d1 create <near-name> --location weur`,
`npx wrangler d1 create <far-name> --location enam` and
`npx wrangler r2 bucket create <bucket-name>`. Replace each name with one chosen for
this test. Use the returned database IDs and the bucket name in an ignored Wrangler configuration
with these bindings:

- `NEAR` and `FAR`: the two D1 databases.
- `STORE`: the R2 bucket.
- `SPIKE`: the `SpikeContainer` SQLite Durable Object, added in a `v1` migration.
- Container: this folder's Dockerfile and build context, one `basic` instance.

Set the Worker entry point to this folder's `worker.ts`, enable `workers_dev`, and use the
`2026-09-01` compatibility date with `nodejs_compat`. Generate a random `TEST_KEY` in a private JSON
secrets file. Deploy with
`npx wrangler deploy --config <config-file> --secrets-file <secrets-file>`; never commit
that file.

All requests require `Authorization: Bearer <TEST_KEY>`. Call these endpoints in order:

1. `/initialize`: create the revision guard in both databases (once).
2. `/measure`, then `/measure?far`: 20 read and guarded-commit samples per database, plus an R2
   write/read. Record the running container's location using
   `wrangler containers instances <application-id>` and the D1 regions from the results.
3. `/busy`: 70 seconds of busy state, with a 20-second sleep timeout. Send no requests to the
   container for 90 seconds. `/events` reads R2 directly without waking it; verify a busy activity
   event, then an idle event and normal stop for that same process.
4. `/schedule`: schedule a wake in 60 seconds. Again send no container requests. After 65 seconds,
   `/events` must contain a wake event.
5. `/grace`, then `/stop`: the SIGTERM handler records progress every five seconds before exiting
   after 60 seconds. After 65 seconds, check `/events` for the signal, progress and container stop.
   This measures a lower bound on available shutdown time; it does not establish rollout or
   platform-failure guarantees.

From the repository root, check both programs:

```sh
npx tsc --noEmit -p packages/cloudflare/spike/tsconfig.json
npx tsc --noEmit --strict --module nodenext --types node packages/cloudflare/spike/server.ts
```

After saving results, delete the container application, Worker, every object in the bucket, the
bucket, both D1 databases, and all probe image tags in the managed registry. Remove local probe
images and the generated config and secrets. Verify that no resources with the chosen prefix remain.
Keep the source and results so others can repeat the test.

## D1 batch contract

This separate probe tests the service's grouped database writes against deployed D1. Run
`node packages/cloudflare/scripts/batch_smoke.ts` from the repository root after signing in
with Wrangler. This creates a uniquely named temporary Worker, controller, D1 database and container
image; runs the shared batch cases from inside the container; saves
`.quaso/beta-2-evidence/d1-contract.json`; and deletes its resources in a `finally` block. A cleanup
failure is reported with the resource prefix for follow-up.

Add `--upload` to run the shared upload cases from the container, measure three samples each of
added, changed and unchanged 3,000-string uploads, and probe deployed D1 limits. Results go to
`.quaso/beta-2-evidence/d1-upload.json`. The probe sets a limit of 1,000 subrequests for each call
to the Worker and tests individual calls separately from batches. The script waits for both the
Worker route and container provisioning, removes local probe image tags, and checks cloud listings
after deletion. No translation provider is called; automatic jobs are created only to check their
write set.
