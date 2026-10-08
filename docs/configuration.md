# Configuration reference

The process environment takes precedence over a `.env` file in the working directory. Empty values
count as unset. Booleans accept `true/false`, `1/0`, `yes/no` and `on/off`. Startup reports all
invalid settings together. The supplied [environment template](../deploy/.env.example) comments
every variable.

“Docker” includes a local binary or development server. “Both” means local storage and Cloudflare;
on Cloudflare set credentials as Worker secrets, and the Worker passes them to the server in the
container. Do not put secrets in git. See [Docker](deploy-docker.md) and
[Cloudflare](deploy-cloudflare.md) setup.

## Required for your setup

| Variable       | Default           | Applies to | Example                 | Meaning                                                                                                |
| -------------- | ----------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `QUASO_DOMAIN` | unset             | Docker     | `translate.example.com` | Hostname Caddy serves. Sets the default PUBLIC_URL; needed by the supplied Compose file.               |
| `SECRET_KEY`   | generated locally | Both       | `openssl rand -hex 32`  | Legacy remote-service mode only. Supported Beta 2 hosts generate instance credentials in the database. |

## Sign-in and email

| Variable                | Default | Applies to | Example                | Meaning                                                                               |
| ----------------------- | ------- | ---------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `SETUP_KEY`             | unset   | Both       | `openssl rand -hex 16` | At least 16 characters; required until initial setup completes. Enter it at `/setup`. |
| `GITHUB_CLIENT_ID`      | unset   | Both       | `your-client-id`       | GitHub OAuth client ID; set with its secret.                                          |
| `GITHUB_CLIENT_SECRET`  | unset   | Both       | `your-client-secret`   | GitHub OAuth secret.                                                                  |
| `DISCORD_CLIENT_ID`     | unset   | Both       | `your-client-id`       | Discord OAuth client ID; set with its secret.                                         |
| `DISCORD_CLIENT_SECRET` | unset   | Both       | `your-client-secret`   | Discord OAuth secret.                                                                 |
| `TURNSTILE_SITE_KEY`    | unset   | Both       | `your-site-key`        | Optional human-check site key; set with the secret.                                   |
| `TURNSTILE_SECRET_KEY`  | unset   | Both       | `your-secret-key`      | Human-check secret for sign-up and volunteer requests.                                |

## LLM

Configure Gemini in Settings → LLM translation. The API key is stored write-only in the
instance database. The default model is `gemini-flash-latest`, requests in parallel default to
4 (range 1–64), and the monthly token budget defaults to unlimited. A positive integer sets
that budget; clearing it removes the limit. Jobs resume when the budget is raised or cleared.
Key replacement and setting changes take effect without restarting the server.

The server no longer reads `GEMINI_API_KEY`, `GEMINI_MODEL`, `LLM_CONCURRENCY` or
`LLM_MONTHLY_TOKEN_BUDGET` from the environment.

## Storage and backups

| Variable   | Default                      | Applies to | Example | Meaning                                                                     |
| ---------- | ---------------------------- | ---------- | ------- | --------------------------------------------------------------------------- |
| `DATA_DIR` | /data; .quaso in development | Docker     | `/data` | Local database, key and backups directory. Ignored with Cloudflare storage. |

## Cloudflare

`QUASO_CLOUDFLARE` set to `true` selects the server's private D1 and R2 storage. The container
controller sets it; leave it unset for Docker and VM deployments. This mode generates its
credentials in the database and reaches storage through fixed private hostnames.

The Worker's own settings come from the instance's `quaso.cloudflare.jsonc`, not from the server's
environment:

| Setting        | Default            | Example | Meaning                                                                                    |
| -------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `sleepAfter`   | 10m; 5m in staging | `30m`   | Inactivity timeout before the container sleeps (the Worker's `CONTAINER_SLEEP_AFTER`).     |
| `locationHint` | unset              | `weur`  | Where D1, R2 and the container controller are created: wnam, enam, weur, eeur, apac or oc. |

## Operations

| Variable       | Default                                       | Applies to | Example                                               | Meaning                                                                                               |
| -------------- | --------------------------------------------- | ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`   | https://QUASO_DOMAIN or http://localhost:PORT | Both       | `https://translate.example.com`                       | Public origin, without a path. Used in links and OAuth callbacks.                                     |
| `PORT`         | 8000                                          | Docker     | `8000`                                                | Listening port, integer 1–65535. Cloudflare container uses 8000.                                      |
| `TRUST_PROXY`  | false; true in supplied Compose .env          | Both       | `true`                                                | Trust forwarded client IP and request ID only behind a trusted proxy. Cloudflare container sets true. |
| `LOG_LEVEL`    | info                                          | Both       | `warn`                                                | debug, info, warn or error; JSON logs to stdout.                                                      |
| `CORS_ORIGINS` | empty                                         | Both       | `https://app.example.com,https://preview.example.com` | Comma-separated origins allowed to call the API with credentials. No wildcards or paths.              |
| `WEB_DIR`      | bundled website or packages/web/dist          | Docker     | `/srv/quaso-web`                                      | Alternate built website directory.                                                                    |
| `QUASO_DEV`    | false                                         | Docker     | `1`                                                   | Development seed/login and fake translator. Never enable on a public instance.                        |

## CLI and build settings

`QUASO_HOSTNAME` and `QUASO_API_KEY` are CLI settings, not server settings; see [the CLI](cli.md).
The project website build accepts `BASE_PATH` and `SITE_REPOSITORY_URL`; see
[releasing](releasing.md). Project name, languages, plural overrides, translation instructions,
prompt, batching and QA settings are stored in the database and edited in Settings. They are not
environment variables.

## Retention settings

Settings → Retention controls `fileHistoryDays` (default 90, range 0–36500) and
`backupRetentionDays` (default 30, range 1–36500). Changes apply on the next cleanup
or backup, without restarting. Zero file-history days removes replaced versions;
current versions are always kept. Local backups retain every copy for 48 hours, then
the newest copy per UTC day within the configured window. Cloudflare keeps nightly
exports within that window. The server ignores the former retention environment variables.

## Email settings

Settings → Email stores the provider (Off, Resend, Postmark or Cloudflare), sender
address and, for Cloudflare, account ID. Enter the write-only email API key there,
save the configuration and send a test to an address you control. The provider must
authorize your sender domain. Changes apply to the next message without restarting.
The server ignores the former email environment variables. Test success means the
provider accepted the message; check the recipient inbox for delivery.

## Language requests

Settings → Language requests enables the public request board and member voting. It is off by
default. Turning it off hides the board and rejects new requests and votes; existing votes are
kept and appear again when enabled. Visitor email confirmation is still under development.
