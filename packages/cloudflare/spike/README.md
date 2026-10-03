# B2.S1 container spike

This is a temporary probe, not an application deployment. Store local measurements in the
git-ignored `.quaso/beta-2-evidence/` directory.

Create uniquely named D1 databases with `wrangler d1 create --location weur` and
`--location enam`, and an R2 bucket with `wrangler r2 bucket create`. Use the returned
IDs in a git-ignored Wrangler configuration with these bindings:

- `NEAR` and `FAR`: the two D1 databases.
- `STORE`: the R2 bucket.
- `SPIKE`: the `SpikeContainer` SQLite Durable Object, added in a `v1` migration.
- Container: this folder's Dockerfile and build context, one `basic` instance.

Set the Worker entry point to `worker.ts`, enable `workers_dev`, and use the
`2026-09-01` compatibility date with `nodejs_compat`. Generate a random `TEST_KEY`
in a private JSON secrets file. Deploy with `wrangler deploy --config <file>
--secrets-file <file>`; never commit that file.

All requests require `Authorization: Bearer <TEST_KEY>`. Call these endpoints in order:

1. `/initialize`: create the revision guard in both databases (once).
2. `/measure`, then `/measure?far`: 20 read and guarded-commit samples per database,
   plus an R2 write/read. Record the running container's location using
   `wrangler containers instances <application-id>` and the D1 regions from the results.
3. `/busy`: 70 seconds of busy state, with a 20-second sleep timeout. Send no requests
   to the container for 90 seconds. `/events` reads R2 directly without waking it;
   verify a busy activity event, then an idle event and normal stop for that same process.
4. `/schedule`: schedule a wake in 60 seconds. Again send no container requests.
   After 65 seconds, `/events` must contain a wake event.
5. `/grace`, then `/stop`: the SIGTERM handler records progress every five seconds
   before exiting after 60 seconds. After 65 seconds, inspect `/events` for the signal,
   grace progress and exit. This measures a lower bound on available shutdown time;
   it does not establish rollout or platform-failure guarantees.

Check types with `bunx tsc --noEmit -p packages/cloudflare/spike/tsconfig.json` from
repository root. Check `server.ts` separately with the root's Bun types.

After saving results, delete the container application, Worker, every object in the
bucket, the bucket, both D1 databases, and all probe image tags in the managed registry.
Remove local probe images and the generated config and secrets. Verify that no resources
with the chosen prefix remain. Keep the probe source and measurements for reproducibility.

## D1 batch contract

Run `bun packages/cloudflare/scripts/batch_smoke.ts` from repository root after
`wrangler login`. This creates a uniquely named temporary Worker, controller, D1
database and container image; runs the shared batch cases from inside the container;
saves `.quaso/beta-2-evidence/d1-contract.json`; and deletes its resources in a `finally`
block. A cleanup failure is reported with the resource prefix for follow-up.

Add `--upload` to run the shared upload cases from the container, measure three samples
each of added, changed and unchanged 3,000-string uploads, and probe deployed D1 limits.
Results go to `.quaso/beta-2-evidence/d1-upload.json`. The probe explicitly configures
1,000 subrequests per Worker invocation and tests individual calls separately from batches.
The script waits for both the Worker route and container provisioning, removes local
probe image tags, and checks cloud listings after deletion. No LLM provider is called;
automatic jobs are created only to check their write set.
