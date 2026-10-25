# API reference

Use Quaso's application programming interface (API) over HTTP to read project data or build an
integration. The base path is `/api/v1`. For repository uploads and downloads, the [CLI](cli.md)
already handles file paths, retries, and local safety checks.

## Discover the API

Fetch `/api/v1/openapi.json` from your instance for the full route list, request schemas, access
rules, and error format. The document uses OpenAPI 3.1 and comes from the same route definitions
as the server. Some access labels differ from the permissions the service enforces, including
personal API keys and quality jobs. Use the access rules below, and check the caller's current
role and language assignments. Success response schemas currently describe a generic object; the sections below
explain the main response fields.

The examples use `https://translate.example.com`. Replace it with your instance URL. Most requests
and responses use JSON. Send `Content-Type: application/json` for a JSON body. Query lists use
commas, as in `?languages=de,fr`; JSON bodies use arrays. Source upload and translation import
bodies have a 50 MiB limit (52,428,800 bytes). Most other JSON request bodies have a 1 MiB limit
(1,048,576 bytes).

## Authentication and access

Create an API key in **Account → API keys**, then send it in the `Authorization` header:

```sh
export QUASO_API_KEY='your API key'
curl --fail-with-body \
  -H "Authorization: Bearer $QUASO_API_KEY" \
  https://translate.example.com/api/v1/status
```

These shell examples use Bash or another POSIX shell. Keep the key outside version control.
Access depends on the route:

| Access                                     | Allowed callers                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Public project data                        | Anyone, without a key: project, source files, strings, history, and activity.                                 |
| Status, export, and file versions          | An administrator's key with `read` or `upload` scope, or an administrator's session.                          |
| Source upload and translation import       | An administrator's key with `upload` scope, or an administrator's session.                                    |
| Translation jobs, models, and usage        | A manager's or administrator's key with `upload` scope, or their session. Assigned languages limit job scope. |
| Settings and provider secrets              | An administrator's session. API keys do not grant this access.                                                |
| Create, list, and revoke personal API keys | A signed-in account can manage its own keys. Administrators can also list and revoke everyone's keys.         |

A personal key grants only actions allowed by both its scope and its creator's current role.
Role changes take effect for existing keys; deleting the creator's account disables them. Jobs
also respect the creator's assigned languages. Keys created by the server's system actor, such as
local development keys, use their scope without a person's role limit.

Manage personal keys through `GET` or `POST /api/v1/api-tokens` and
`DELETE /api/v1/api-tokens/{id}`. Creation takes `{name, scope}`; the secret is shown only in the
creation response. These routes require a session, not a bearer key.

The website uses a `quaso_session` cookie. A bearer key takes precedence over a session cookie.
The OpenAPI document describes the access needed for each route, including contributor and
manager actions. A `read` key does not make the project's public content private.

## Errors

API errors use this shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "A description of the problem",
    "details": [{ "path": "files[0].path", "message": "A field-specific problem" }]
  }
}
```

`details` is optional. Depending on the error, it can identify a request path, file, key, language,
check, line, or column. A translation conflict can also include the current translation in
`error.current`.

| HTTP status | Common error codes                 | Action                                                 |
| ----------- | ---------------------------------- | ------------------------------------------------------ |
| 400         | `bad_request`, `validation_failed` | Fix the request using the message and details.         |
| 401         | `unauthorized`                     | Supply a valid key or sign in.                         |
| 403         | `forbidden`, `setup_required`      | Check access or complete instance setup.               |
| 404         | `not_found`                        | Check the file, language, or other requested item.     |
| 409         | `conflict`                         | Read the current value before applying an edit again.  |
| 410         | `expired`                          | The stored file version is no longer available.        |
| 413         | `payload_too_large`                | Reduce the request body.                               |
| 422         | `invalid_source`, `qa_failed`      | Fix the source file or reported quality check.         |
| 429         | `rate_limited`, `budget_exceeded`  | Check the limit or translation budget before retrying. |
| 503         | `llm_unavailable`, `unavailable`   | Check the provider or instance state.                  |
| 500         | `internal`                         | Check the server logs.                                 |

An import can return HTTP 200 while refusing some values. A job can also finish with failed
strings. Inspect the result fields; the HTTP status alone does not prove that every item succeeded.
After a lost response to a write, check its result before sending it again.

## Source files

`GET /api/v1/files` is public. Without `language`, it lists active source files independently of
translations, including projects that have no target languages:

```json
{
  "files": [
    {
      "id": 1,
      "path": "menu.json",
      "repoPath": "src/locales/en/menu.json",
      "strings": 12,
      "words": 35,
      "updatedAt": 1791021600000,
      "revision": 7
    }
  ]
}
```

`path` is the server identity below the source glob's base. `repoPath` is the display path relative
to `quaso.config.json`. Uploads require both; downloads and imports use `path`.

A path ends in `.json`, an i18next file, or in `.md` or `.markdown`, a Markdown document: one
string with an empty `key`, translated whole, which `GET /strings` marks with `document: true`. In
`GET /export`, a document with nothing to write (untranslated or outdated, with `omit`) has an
empty `content`: the CLI deletes the local file instead of writing an empty one. A JSON export always has JSON content. Local edits can prevent the CLI from deleting a document;
see [download safety](cli.md#quaso-download).

`strings` counts active translatable entries, and `words` counts their source words. Empty files
remain listed with zero counts. `updatedAt` is a Unix timestamp in milliseconds, and `revision` is
the project revision of the upload that last changed that file. Repeat uploads, previews,
translations and context edits leave these two values unchanged. Hidden files are omitted. The optional `ambiguities` list reports model warnings about unclear
source text. String details can include `sourceWarnings` and links to `identicalSources`.

With `GET /api/v1/files?language=de`, the response includes the canonical `language` tag and each
file's `id`, `path`, `repoPath`, and translation progress: strings, words, untranslated, green, blue,
outdated, pending, QA, words left, translated percentage and proofread percentage. An unknown
language returns `404`.

## Upload source files

`POST /api/v1/sources` accepts file contents as strings in a JSON request body. A file can contain i18next JSON or a
whole Markdown document. This example adds or updates one file
without hiding other files:

```json
{
  "sourceLanguage": "en",
  "languages": ["de", "fr"],
  "partial": true,
  "dryRun": true,
  "files": [
    {
      "path": "menu.json",
      "repoPath": "src/locales/en/menu.json",
      "content": "{\"play\":\"Play\"}\n"
    }
  ]
}
```

`path` and `repoPath` are required for each file. The source language must match the instance once
it has strings. Missing target languages are added from `languages`; existing languages are kept.
Optional `renames`, `limits`, `pluralExclusions`, `arguments`, and `descriptionSuffix` follow the
request schema. `arguments` replaces the declared arguments of every string in the uploaded files;
`GET /api/v1/strings/{id}` lists a string's `arguments` when ICU MessageFormat is on (see
[Arguments the English doesn't show](file-formats.md#arguments-the-english-doesnt-show)).
Each JSON source file can include `descriptions`, a string containing a JSON object of descriptions
with matching key paths. Description entries are metadata, not translation strings. See
[the CLI config reference](cli.md#the-config-file) and [File formats](file-formats.md) for their meaning.

Use `dryRun: true` to preview, then send the reviewed request without it to apply the changes.
With `partial` omitted or false, files missing from the request are hidden. Their translations and
history remain. Use `partial: true` when the request contains only part of the project.

The response includes per-file counts, added and changed keys, `renameSuggestions`, `hiddenFiles`,
`languagesAdded`, `warnings`, and the project `revision`. `uploadId` is null for a preview or an
unchanged upload. `job` is an ID object when the upload starts automatic translation, or null.

## Download translations

`GET /api/v1/export?languages=de,fr&files=menu.json` returns a JSON object with `schemaVersion`,
`revision`, `sourceLanguage`, and `files`. Each file has these fields:

```json
{
  "path": "menu.json",
  "language": "de",
  "content": "{\"play\":\"Spielen\"}\n",
  "sha256": "1dfbe627328363c21ea4e944e8486b3448132297ea7f7a09448b6b498b1b4697"
}
```

Omit `languages` to export all target languages and `files` to export all active files. Unknown
languages return 400; unknown files return 404. File paths are server identities, not local destination paths.

By default, a normal export reads current accepted values, including green, blue, and outdated translations.
It excludes pending suggestions and hidden strings. Missing translations use source text by
default. `untranslated=omit` leaves them out, including incomplete arrays and missing plural forms.
Set `outdated=omit` to leave out older-source translations, including arrays that contain them.
When an export includes older-source values, its file object adds `outdated: [{key, sourceRevision}]`;
the revision is the source file's latest upload revision. See [File formats](file-formats.md)
before using omission with your game's fallback behavior.

For stored history, add `at=2026-09-01T00:00Z`. The time must be in UTC and end in `Z`. Historical
exports read the published version current at that time and cannot use `untranslated=omit` or `outdated=omit`.
Publication runs after five seconds without relevant writes, with a one-minute maximum delay.
Normal exports do not wait for publication.

Use `GET /api/v1/files/menu.json/versions?language=de` to list retained versions. Use
`GET /api/v1/files/menu.json/versions/123` to fetch version 123 and its content. A missing stored
version object returns `410 expired`. Retention limits are described in [Operations](operations.md).

## Read translation status

`GET /api/v1/status` returns `revision`, `sourceLanguage`, and `languages`, including counts for each
language and file. Add `?language=de` to select one target language.

Counts include untranslated, green, blue, outdated, pending, and QA states. Percentages count source
words. Read [Translation concepts](concepts.md) before choosing release conditions: accepted
translations can still be outdated or have quality assurance (QA) errors.

## Import translations

`POST /api/v1/imports` imports one target language per request. Upload sources and add the target
language first. Send file identities and text in the matching format, as in this preview of a JSON file:

```json
{
  "language": "de",
  "as": "green",
  "dryRun": true,
  "files": [{ "path": "menu.json", "content": "{\"play\":\"Spielen\"}\n" }]
}
```

`as` is required: `green` means translated and `blue` means proofread. Existing blue translations
are kept unless `overwrite` is true. Values identical to the source are skipped unless
`keepIdentical` is true. Empty values are always skipped, including blank Markdown documents. A Markdown
translation with text is imported as a whole file. Unknown keys and files are reported;
unused plural forms are dropped. With `allowQaErrors: true`, values that fail quality checks are
imported with their errors instead of refused.

Check `imported`, `unchanged`, `skippedIdentical`, `skippedEmpty`, `skippedBlue`, `droppedForms`,
`refused`, `flagged`, `unknownKeys`, and `unknownFiles` in the response. Remove `dryRun` only after
reviewing the preview. See [Migrate from Crowdin](migrate-from-crowdin.md) for preserving approval
states through two imports.

## Translation estimates

`GET /api/v1/project` includes `referenceLanguages`, the language tags used as references for the large language model (LLM). Managers can read these reference language tags without access to Settings.

`POST /api/v1/llm-suggestions` accepts `{language, ids}` with one to eight string IDs. It returns
`{suggestions: [{id, value, model}], failed: [{id, message}]}` without saving translations. The
editor uses these results to offer drafts while a person types. The caller needs permission to
edit that language: a manager or administrator session. API keys cannot edit translations.

Each file's strings share one request with the job's prompt and quality checks. The request asks
for the least thinking the model supports, is not retried, and ends after 30 seconds. Tokens count
toward usage and the monthly budget. A string without a result appears in `failed`. A missing
provider returns 503; a spent budget returns 429.

`POST /api/v1/jobs` with `dryRun: true` returns `job: null` and an `estimate`, without creating
a job. It requires translation permission and accepts the same scope as a real job.

The estimate includes total `strings`, `words` and `requests`, `estimatedTokens` for input and
output, and two breakdowns: `languages: [{language, strings, words}]` and
`files: [{file, strings, words}]`. Each `file` is a server identity. File counts sum work across
the selected languages; translating one source string into two languages counts twice.
The `work` object separates `translate`, `retranslate`, `update`, and `propose` counts. Optional
`outdated` and `outdatedLeft` counts show older-source values in scope and those excluded from the
run. The estimate includes only work selected by the request's files, strings, and options. Files with
no work are left out; if no strings need translation, the file breakdown is empty.

## Translation jobs

`POST /api/v1/jobs` starts a job with the same request as a preview, without `dryRun: true`:

```json
{
  "languages": ["de", "fr"],
  "files": ["menu.json"],
  "outdated": true
}
```

Omitted languages and files select all targets and active files within the caller's allowed
languages. Jobs translate untranslated strings by default. `outdated` defaults to true: it updates
outdated green values and proposes changes to outdated blue values. `retranslate: true` also
translates other green values again; `qa: true` also selects green values with quality errors.
Blue values are never replaced by the job. Optional `strings`, `instruction`, and `model` narrow
or adjust the request; see the OpenAPI schema for limits.

The response is `{job, estimate: null}`. Use the returned job ID to follow its progress:

| Request                          | Result                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| `GET /api/v1/jobs/{id}`          | Job status, progress, token counts, failures, and any error. |
| `GET /api/v1/jobs`               | The 50 newest jobs.                                          |
| `GET /api/v1/jobs?active=true`   | All queued or running jobs; paused jobs are excluded.        |
| `DELETE /api/v1/jobs/{id}`       | Cancel a job. An API key can cancel only jobs it started.    |
| `GET /api/v1/models`             | Models offered by the configured provider.                   |
| `GET /api/v1/usage?period=month` | Token usage and budget; `period=day` gives daily totals.     |

Job states are `queued`, `running`, `done`, `failed`, `cancelled`, and `paused`. A `done` job can
still have failed strings. Inspect `progress.failed`, `failures`, and `error`. A job paused for a
rejected Gemini key or a spent monthly budget can resume after the key or budget issue is resolved.
Optional `progress.reused` counts exact matches copied through translation memory; `notes` holds
model warnings about source meaning or reference translations. These notes do not replace a
person's review.

## Meaning and terminology checks

`POST /api/v1/quality-jobs` starts a meaning check with `{ "kind": "meaning", "languages": ["es"],
"files": ["common.json"] }`; optional `strings` or `suggestions` IDs narrow the scope.
`GET /api/v1/quality-jobs` and `GET /api/v1/quality-jobs/{id}` report progress and findings.
These requests require translation permission and respect assigned languages. Warnings do not block saves; no accepted text is replaced.

Quality jobs also accept `kind: "terminology"` and `kind: "style_guide"`. Terminology jobs support
`minimumFrequency` (default 3) and `minimumFiles` (default 2); reports include counts and examples from the project. `PATCH /api/v1/quality-jobs/{id}/suggestions/{index}` accepts or dismisses a
term with `{ "action": "accept", "translation": "preferred rendering" }` or `{ "action": "dismiss" }`.
Accepting a term also needs glossary permission: use a manager or administrator session. API keys
can request reports but cannot write glossary terms. Style-guide generation requires an
administrator session and returns drafts; review them before saving `instructions` through
`PATCH /api/v1/languages/{tag}`.

## Provider secrets

Signed-in administrators can manage `gemini_api_key` and `email_api_key` through:

- `GET /api/v1/settings/secrets`: `{secrets: [{name, set, ending, updatedAt}], missingSecrets}`.
- `PUT /api/v1/settings/secrets/{name}` with `{value: "credential"}`: the updated status.
- `DELETE /api/v1/settings/secrets/{name}`: the cleared status.

Responses never include the value. `ending` is the last four characters, or `null` for an
unset credential or a value with at most four characters. `updatedAt` is a Unix timestamp in
milliseconds, or `null` when unset. Repeating the same write does not update its timestamp
or add an activity entry. Activity records the name and action, without the credential or its last four characters.
Internal instance credentials cannot be edited through these routes.

JSON and SQLite backup downloads exclude secret values. SQLite downloads remove secret values and unused database space; the operator's database and retained volume copies keep their values.
Backup metadata retains only the names of configured provider credentials. Restore results include
`missingSecrets`, the names to enter again. Settings shows the same list until those keys are
re-entered or removed. The AI translation and Email delivery sections offer controls to set, replace, or remove keys
without showing their full value.
Gemini reads the stored key. `PATCH /api/v1/settings` accepts `llm.model`, `llm.suggestionModel`
(the model for the editor's suggestions, `""` to use `llm.model`), `llm.concurrency`
(an integer from 1 to 64) and `llm.monthlyTokenBudget` (a positive safe integer, or `null` for
unlimited). The default concurrency is 4. Key and limit changes apply to the next unit of background work without restarting the server. Key or budget
changes resume paused jobs. Replacing or removing the key also clears the saved model list.
`POST /api/v1/settings/llm/test` with `{}` requires an administrator and checks the saved
Gemini key with a new model request. It returns `{ok: true, models, keyUpdatedAt}`; models
are unique and sorted, and `keyUpdatedAt` identifies the tested version of the key. The panel
shows these models and hides a previous result after replacing or removing the key. Save a
draft key before testing it. A missing/rejected key or no compatible models returns `400`;
an unavailable provider returns `503`. Provider diagnostics and credential values are never
included in the response.

`PATCH /api/v1/settings` also accepts `fileHistoryDays` (integer 0–36500, default 90)
and `backupRetentionDays` (integer 1–36500, default 30). They apply to the next cleanup
or backup without restarting. Current file versions and the most recent 48 hours of
local backups are always retained.

Email configuration is stored through `PATCH /api/v1/settings` as a complete `email`
object: `{provider: "resend", from: "Quaso <quaso@example.com>", accountId: ""}`.
Providers are `none` (default), `resend`, `postmark` and `cloudflare`; Cloudflare needs
its 32-character account ID. Set the write-only `email_api_key` separately.
`POST /api/v1/settings/email/test` with `{to: "you@example.com"}` requires an
administrator and sends one test message with the saved settings. Success returns
`{ok: true, keyUpdatedAt}`; failures omit credentials and provider diagnostics.
