# Configuration reference

Use environment variables for server startup, `quaso.cloudflare.jsonc` for Cloudflare deployment,
and **Settings** for project choices, provider keys and retention. This page describes all three.

The process environment takes precedence over a `.env` file in the working directory. Empty values
count as unset. On/off settings accept `true/false`, `1/0`, `yes/no` and `on/off`. Startup reports
all invalid settings together. The supplied [environment template](../deploy/.env.example) lists the
server variables. Restart the server after changing its environment. For Docker Compose, run
`docker compose up -d` to apply changes to `.env`; `docker compose restart` does not load a changed
environment.

In the tables, **Docker** also includes a server run with Node from a checkout, or the development server. **Both** means local
storage and Cloudflare; on Cloudflare set credentials as Worker secrets, and the Worker passes them
to the server in the container. Do not put secrets in git. See [Docker](deploy-docker.md) and
[Cloudflare](deploy-cloudflare.md) setup.

## Required for your setup

| Variable       | Default | Applies to | Example                 | Meaning                                                                                                              |
| -------------- | ------- | ---------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `QUASO_DOMAIN` | unset   | Docker     | `translate.example.com` | Hostname Caddy serves. Sets the default `PUBLIC_URL`; needed by the supplied Compose file.                           |
| `SECRET_KEY`   | unset   | Cloudflare | `openssl rand -hex 32`  | At least 32 characters. `cf:setup` generates this Worker secret. The server generates separate keys in its database. |

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

Quaso uses a large language model (LLM) for machine translation. Configure Gemini in **Settings → AI
translation**. Quaso stores the API key in the instance database and never returns its value through
the settings API or website. Write-only access does not mean encryption at rest: protect the
database and any full storage copies.

The default model is `gemini-flash-latest`. Settings lists the provider's models that support text
generation, excluding names for speech, image, audio, live, robotics and computer-use models. If no
models are available, enter a model name. A saved model remains selectable even if it is no longer
listed. **Model for editor suggestions** and **Meaning-check model** each follow the project model
by default; set either to use another model for that task.

Requests in parallel default to 4 (range 1–64), and the monthly token budget defaults to unlimited.
A positive integer sets that budget; clearing it removes the limit. Jobs resume when the budget is
raised or cleared. New job work reads changed settings and keys without restarting the server; a
request already in progress can finish with its previous settings.

Automatic translation on upload is on by default. Reuse of translations of identical source text
(`translationMemory`) is off by default. Automatic meaning checks are also off. When enabled with
the defaults, they check proofread translations on save and approval, and count against the monthly
token budget. These checks report warnings; review them before deciding whether to change a
translation. See [the translation workflow](workflow.md) and [the website guide](website.md).

The server no longer reads `GEMINI_API_KEY`, `GEMINI_MODEL`, `LLM_CONCURRENCY` or
`LLM_MONTHLY_TOKEN_BUDGET` from the environment.

## Storage and backups

| Variable   | Default                          | Applies to | Example | Meaning                                                                                                                          |
| ---------- | -------------------------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR` | `/data`; `.quaso` in development | Docker     | `/data` | Local database, lock file, temporary files and object store. Instance keys are in the database. Ignored with Cloudflare storage. |

## Cloudflare

`QUASO_CLOUDFLARE` set to `true` selects the server's private D1 and R2 storage. The container
controller sets it; leave it unset for Docker and VM deployments. This mode generates its
credentials in the database and reaches storage through fixed private hostnames.

The deployment reads each named environment from `quaso.cloudflare.jsonc`. It records the account,
hostname, Worker name, D1 database ID and name, R2 bucket name, image and these settings:

| Setting        | Default            | Example | Meaning                                                                                                                                                           |
| -------------- | ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sleepAfter`   | 10m; 5m in staging | `30m`   | Inactivity timeout before the container sleeps (the Worker's `CONTAINER_SLEEP_AFTER`).                                                                            |
| `locationHint` | unset              | `weur`  | Preferred region for creating D1, R2 and the container controller. Setup accepts `wnam`, `enam`, `weur`, `eeur`, `apac` or `oc`. It does not guarantee placement. |

Changing a location hint does not move an existing database or bucket. Use `cf:setup` to create an
instance and `cf:deploy --env production` to apply later hostname, image or sleep settings. Use
`--image` to override the saved image for one deployment without changing the instance file. Keep
the source checkout and image on the same tested release. See
[Cloudflare deployment](deploy-cloudflare.md).

## Operations

| Variable       | Default                                           | Applies to | Example                                               | Meaning                                                                                               |
| -------------- | ------------------------------------------------- | ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`   | `https://QUASO_DOMAIN` or `http://localhost:PORT` | Both       | `https://translate.example.com`                       | Public origin, without a path. Used in links and OAuth callbacks.                                     |
| `PORT`         | 8000                                              | Docker     | `8000`                                                | Listening port, integer 1–65535. Cloudflare container uses 8000.                                      |
| `TRUST_PROXY`  | false; true in supplied Compose `.env`            | Both       | `true`                                                | Trust forwarded client IP and request ID only behind a trusted proxy. Cloudflare container sets true. |
| `LOG_LEVEL`    | `info`                                            | Both       | `warn`                                                | `debug`, `info`, `warn` or `error`; JSON logs to standard output.                                     |
| `CORS_ORIGINS` | empty                                             | Both       | `https://app.example.com,https://preview.example.com` | Comma-separated origins allowed to call the API with credentials. No wildcards or paths.              |
| `WEB_DIR`      | bundled website or `packages/web/dist`            | Docker     | `/srv/quaso-web`                                      | Another built website directory.                                                                      |
| `QUASO_DEV`    | false                                             | Docker     | `1`                                                   | Development data, test sign-in and fake translator. Never enable on a public instance.                |

## CLI and build settings

`QUASO_HOSTNAME` and `QUASO_API_KEY` are CLI settings, not server settings; see [the CLI](cli.md).
The project website build accepts `BASE_PATH` and `SITE_REPOSITORY_URL`; see
[releasing](releasing.md). Project name, languages, plural overrides, translation instructions,
prompt, request grouping and quality checks are stored in the database and edited in Settings. They
are not environment variables.

## Retention settings

**Settings → History & retention** controls `fileHistoryDays` (default 90, range 0–36500) and
`backupRetentionDays` (default 30, range 1–36500). Changes apply on the next cleanup or backup,
without restarting. Zero file-history days removes replaced versions at the next cleanup; current
versions are always kept. Local backups retain every copy younger than 48 hours, then the newest
copy per UTC day within the configured window. Cloudflare keeps nightly exports within that window.
The server ignores the former retention environment variables.

## Email settings

**Settings → Email delivery** stores the provider (Off, Resend, Postmark or Cloudflare), sender
address and, for Cloudflare, account ID. Enter the email API key there, save the configuration and
send a test to an address you control. The provider must authorize your sender domain. Changes apply
to the next message without restarting. The server ignores the former email environment variables.
Test success means the provider accepted the message; check the recipient inbox for delivery.

## Language requests

**Settings → Language requests** enables the public request board and member voting. It is off by
default. Turning it off hides the board and rejects new requests and votes; existing votes are kept
and appear again when enabled. People must sign in to submit or vote on a request. Public visitors
can read the board.
