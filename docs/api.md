# API reference

The instance serves its API under `/api/v1`. Its generated OpenAPI document is at
`/api/v1/openapi.json`, including request schemas, authentication requirements and error shapes.

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

`strings` counts active translatable entries, and `words` counts their source words. Empty files
remain listed with zero counts. `updatedAt` is a Unix timestamp in milliseconds, and `revision` is
the project revision of the upload that last changed that file. Repeat uploads, previews,
translations and context edits leave these two values unchanged. Hidden files are omitted.

With `GET /api/v1/files?language=de`, the response includes the canonical `language` tag and each
file's `id`, `path`, `repoPath`, and translation progress: strings, words, untranslated, green, blue,
outdated, pending, QA, words left, translated percentage and proofread percentage. An unknown
language returns `404`.

## Translation estimates

`GET /api/v1/project` includes `referenceLanguages`, the configured language tags used as LLM
references. This public metadata lets managers see the references without access to Settings.

`POST /api/v1/strings/{id}/translations/{lang}/llm-suggestion` with no body returns the LLM's
translation of one string, `{value, model}`, without saving anything: the editor offers it while
someone types their own. It requires permission to edit the language (a manager of it, or an
administrator). The request uses a job's prompt and quality checks and counts in the usage and the
monthly budget. No provider returns `503`, a used-up budget `429`, and an answer that still fails
the checks after the configured retries `503`.

`POST /api/v1/jobs` with `dryRun: true` returns `job: null` and an `estimate`, without creating
a job. It requires translation permission and accepts the same scope as a real job.

The estimate includes total `strings`, `words` and `requests`, `estimatedTokens` for input and
output, and two breakdowns: `languages: [{language, strings, words}]` and
`files: [{file, strings, words}]`. Each `file` is a server identity. File counts sum work across
the selected languages; translating one source string into two languages counts twice.
Only eligible work contributes, including the selected files, strings, and outdated/retranslation
options. Files with no work are omitted; a scope with no eligible work returns an empty file breakdown.

## Provider secrets

Administrators can manage `gemini_api_key` and `email_api_key` through:

- `GET /api/v1/settings/secrets`: `{secrets: [{name, set, ending, updatedAt}], missingSecrets}`.
- `PUT /api/v1/settings/secrets/{name}` with `{value: "credential"}`: the updated status.
- `DELETE /api/v1/settings/secrets/{name}`: the cleared status.

Responses never include the value. `ending` is the last four characters, or `null` for an
unset credential or a value with at most four characters. `updatedAt` is a Unix timestamp in
milliseconds, or `null` when unset. Repeating an unchanged write does not update its timestamp
or add an activity entry. Activity records the name and action, without the credential or suffix.
Internal instance credentials cannot be edited through these routes.

JSON and SQLite backup downloads exclude secret values. SQLite snapshots are redacted and
compacted before download; the operator's database and retained volume copies keep their values.
Backup metadata retains only the names of configured provider credentials. Restore results include
`missingSecrets`, the names to enter again. Settings shows the same list until those keys are
re-entered or removed. The LLM and Email sections offer masked set/replace/remove controls.
Gemini reads the stored key. `PATCH /api/v1/settings` accepts `llm.model`, `llm.concurrency`
(an integer from 1 to 64) and `llm.monthlyTokenBudget` (a positive safe integer, or `null` for
unlimited). The default concurrency is 4. Each alarm slice captures its configuration;
key and limit changes apply to subsequent slices without restarting the server. Key or budget
changes resume paused jobs. Replacing or removing the key also invalidates the model list cache.
`POST /api/v1/settings/llm/test` with `{}` requires an administrator and probes the saved
Gemini key with a fresh model request. It returns `{ok: true, models, keyUpdatedAt}`; models
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
