// SPDX-License-Identifier: MIT
/** The fresh Beta 2 schema, shared by SQLite and D1. */
import type { Migration } from "../migrations.ts";
import type { Statement } from "../ports.ts";
import { GUARD_STATEMENTS } from "../write.ts";

const TABLES = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO meta (key, value) VALUES ('schema_generation', 'beta-2');

-- One row of JSON (ProjectSettings in core/api.ts), validated by the schema module.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
) STRICT;

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE languages (
  tag TEXT PRIMARY KEY,
  instructions TEXT NOT NULL DEFAULT '',
  -- JSON PluralOverride, or NULL
  plural_override TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  -- Relative to the source folder, such as common.json
  path TEXT NOT NULL UNIQUE,
  repo_path TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0,
  -- JSON JsonFormat of the English file
  format TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  generated_context TEXT,
  -- 0 when a full upload no longer includes the file: hidden, never deleted
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Every English entry, translatable or not, so downloads can rebuild the structure.
-- Identity is (file, key), never the text (STR-3).
CREATE TABLE strings (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files (id),
  -- entryKey(kind, keyPath) from core
  key TEXT NOT NULL,
  -- JSON KeyPath
  key_path TEXT NOT NULL,
  -- formatKeyPath(keyPath), such as menu.play
  display_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'plural', 'ordinal', 'reference', 'literal')),
  -- JSON: the text (a JSON string), the forms (an object), or, for references and
  -- literals, the JSON string of the value (references) or of the raw JSON (literals)
  source TEXT NOT NULL,
  -- hashValue() of the English, for translatable kinds; of the source column otherwise
  source_hash TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  -- Normalized (NFKC, lower case) key and English, for search
  search_text TEXT NOT NULL,
  position INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  max_length INTEGER,
  -- 1 when the limit comes from the CLI config
  max_length_locked INTEGER NOT NULL DEFAULT 0,
  -- 0 when the key disappeared from the English: hidden, never deleted
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (file_id, key)
) STRICT;
CREATE INDEX strings_file_position ON strings (file_id, active, position);
CREATE INDEX strings_active_kind ON strings (active, kind);

-- The current accepted text of a string in a language: exactly what downloads read.
-- No row means untranslated (red).
CREATE TABLE translations (
  string_id INTEGER NOT NULL REFERENCES strings (id),
  language TEXT NOT NULL,
  -- canonicalValue() JSON: a string, or forms by category
  value TEXT NOT NULL,
  colour TEXT NOT NULL CHECK (colour IN ('green', 'blue')),
  -- The hash of the English it was made for; outdated when it differs (STR-4)
  source_hash TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'llm', 'import', 'token', 'system')),
  author_id INTEGER,
  -- The model for the LLM, or another label
  author_label TEXT,
  approver_id INTEGER,
  -- The project revision of the last change: writes send it back, 409 on a mismatch
  revision INTEGER NOT NULL,
  qa_errors INTEGER NOT NULL DEFAULT 0,
  qa_warnings INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (string_id, language)
) STRICT;
CREATE INDEX translations_language ON translations (language, colour);

-- Changes waiting for review (STR-2), and the LLM's proposals for outdated blue
-- translations (design §5.4). Downloads never read it.
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY,
  string_id INTEGER NOT NULL REFERENCES strings (id),
  language TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('translation', 'correction', 'approval', 'llm')),
  -- canonicalValue() JSON; NULL for approval ("looks good")
  value TEXT,
  source_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'withdrawn')),
  author_type TEXT NOT NULL,
  author_id INTEGER,
  author_label TEXT,
  reviewer_id INTEGER,
  comment TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
) STRICT;
CREATE INDEX suggestions_status ON suggestions (status, language, string_id);
CREATE INDEX suggestions_string ON suggestions (string_id, language, status);
CREATE INDEX suggestions_author ON suggestions (author_id, status);

-- Append-only, written in the same transaction as the change (STR-5).
CREATE TABLE history (
  id INTEGER PRIMARY KEY,
  string_id INTEGER NOT NULL,
  -- NULL for changes to the English
  language TEXT,
  event TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  before_colour TEXT,
  after_colour TEXT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_label TEXT,
  -- JSON: the model and request, the suggestion, the comment, the upload
  detail TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX history_string ON history (string_id, language, id);
CREATE INDEX history_created ON history (created_at);

CREATE TABLE uploads (
  id INTEGER PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  added INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  restored INTEGER NOT NULL,
  moved INTEGER NOT NULL,
  -- JSON UploadFileResult[]
  files TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- The Activity page: uploads, imports, jobs, reviews and renames, newest first.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_label TEXT,
  summary TEXT NOT NULL,
  -- JSON
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;

-- OPS-3: random keys starting with qso_, stored as SHA-256 hashes.
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'upload')),
  secret_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

-- People. A stub until Sprint 6 adds sign-in.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'none'
    CHECK (role IN ('none', 'contributor', 'manager', 'administrator')),
  -- JSON array of language tags the role is limited to (ROLE-3), or NULL for all
  languages TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  password_hash TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  volunteer_status TEXT,
  volunteer_languages TEXT,
  volunteer_message TEXT,
  volunteer_requested_at INTEGER,
  last_seen_at INTEGER
) STRICT;
-- LLM jobs (design §5.6). The work of a job is declarative: the alarm works out what is
-- left from its scope each time, minus the pairs in job_items.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'paused')),
  -- 0 one string (the editor), 1 an upload, 2 bulk: lower runs first
  priority INTEGER NOT NULL CHECK (priority IN (0, 1, 2)),
  source TEXT NOT NULL CHECK (source IN ('website', 'cli', 'upload')),
  -- JSON: JobScope, with the string IDs an upload job was created for
  scope TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_label TEXT,
  -- Strings × languages to process, when last computed
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  translated INTEGER NOT NULL DEFAULT 0,
  proposed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  -- JSON JobFailure[]: the last 200
  failures TEXT NOT NULL DEFAULT '[]',
  -- Why the job failed or paused
  error TEXT,
  -- Alarm runs of this job that failed in a row
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX jobs_status ON jobs (status, priority, id);

-- The pairs a job has processed, so that working out what is left (after a restart, or in
-- re-translation mode) never repeats them. Deleted when the job ends.
CREATE TABLE job_items (
  job_id INTEGER NOT NULL,
  string_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('translated', 'proposed', 'failed', 'skipped')),
  PRIMARY KEY (job_id, string_id, language)
) STRICT;

-- Every request to the provider, for the usage page and the budget (LLM-7).
CREATE TABLE llm_requests (
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  language TEXT,
  file_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- Strings in the request (0 for other requests, such as a file's context)
  strings INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed', 'blocked')),
  error TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX llm_requests_created ON llm_requests (created_at);

-- Proofread translations of identical English, for the prompts' context.
CREATE INDEX strings_source_hash ON strings (source_hash);

-- The last LLM failure of a string in a language, shown on the string until a later
-- translation of the pair succeeds or a person translates it.
CREATE TABLE llm_failures (
  string_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  job_id INTEGER,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (string_id, language)
) STRICT;
CREATE INDEX users_role ON users (role, deleted_at);
CREATE INDEX users_volunteer ON users (volunteer_status);

-- GitHub and Discord accounts linked to a user (S6.4).
CREATE TABLE identities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'discord')),
  -- The provider's account ID
  subject TEXT NOT NULL,
  username TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, subject)
) STRICT;
CREATE INDEX identities_user ON identities (user_id);

-- Sessions (S6.2): the SHA-256 of a random 256-bit ID, never the ID itself.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT
) STRICT;
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Single-use links sent by email, or created by administrators (S6.4): hashed.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  -- The address the link was made for: a verification link only verifies that one
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'signin')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX email_tokens_user ON email_tokens (user_id);
CREATE INDEX email_tokens_expires ON email_tokens (expires_at);

-- Invite links (ROLE-1): single use, expiring, hashed.
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'manager', 'administrator')),
  -- JSON array of language tags the role is limited to, or NULL for all
  languages TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE TABLE glossary_terms (
  id INTEGER PRIMARY KEY,
  term TEXT NOT NULL,
  term_normalized TEXT NOT NULL,
  language TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('translate', 'keep')),
  translation TEXT,
  case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (term_normalized, language, kind)
) STRICT;
-- NULL means all languages, so it needs its own uniqueness constraint in SQLite.
CREATE UNIQUE INDEX glossary_all_languages ON glossary_terms (term_normalized, kind) WHERE language IS NULL;
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  string_id INTEGER NOT NULL REFERENCES strings (id),
  language TEXT,
  body TEXT NOT NULL,
  source_issue INTEGER NOT NULL DEFAULT 0 CHECK (source_issue IN (0, 1)),
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users (id),
  author_id INTEGER REFERENCES users (id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX comments_string ON comments (string_id, deleted_at, id);
CREATE INDEX comments_issues ON comments (source_issue, resolved_at, deleted_at);
CREATE TABLE language_requests (
  id INTEGER PRIMARY KEY,
  tag TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by INTEGER REFERENCES users (id),
  votes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by INTEGER REFERENCES users (id)
) STRICT;
CREATE UNIQUE INDEX language_request_pending ON language_requests (tag) WHERE status = 'pending';
CREATE TABLE language_request_votes (
  request_id INTEGER NOT NULL REFERENCES language_requests (id),
  user_id INTEGER NOT NULL REFERENCES users (id),
  PRIMARY KEY (request_id, user_id)
) STRICT;
CREATE TABLE file_versions (
  id INTEGER PRIMARY KEY,
  language TEXT NOT NULL,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  store_key TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  replaced_at INTEGER
) STRICT;
CREATE UNIQUE INDEX file_versions_current ON file_versions (language, file) WHERE replaced_at IS NULL;
CREATE INDEX file_versions_history ON file_versions (language, file, published_at, id);
`;

// Table definitions contain no triggers or semicolons inside literals; guard triggers stay whole.
export const INITIAL_STATEMENTS: Statement[] = [
  ...TABLES.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((sql) => sql.trim())
    .filter(Boolean)
    .map((sql) => ({ sql })),
  ...GUARD_STATEMENTS,
];

export const MIGRATION_1: Migration = {
  version: 1,
  name: "Beta 2 initial schema",
  sql: INITIAL_STATEMENTS.map(({ sql }) => sql).join(";\n") + ";",
};
