// SPDX-License-Identifier: MIT
/**
 * Accounts (design §5.8, S6.1 to S6.4, S6.10): sign-up and sign-in, the first
 * administrator, the development account, GitHub and Discord identities, the links sent by
 * email, and the account itself, down to its deletion (OPS-3).
 *
 * Synchronous operations join the caller's transaction; async writes use guarded snapshots.
 * Password checks run before either boundary. Completion rechecks the exact checked hash
 * so a concurrent credential change cannot authorize a stale sign-in.
 */
import type {
  ResetLink,
  Role,
  SetupRequest,
  UserInfo,
  SignInRequest,
  SignUpRequest,
  UpdateAccountRequest,
  DeleteAccountRequest,
  ResetPasswordRequest,
} from "@quaso/core";
import { ProjectSettings, sha256Hex } from "@quaso/core";
import type { Actor } from "./api.ts";
import type {
  EmailPurpose,
  EmailTokenResult,
  IdentityInput,
  IdentityProvider,
  IdentityResult,
  SignedIn,
} from "./accounts_api.ts";
import type { Context } from "./context.ts";
import { type Sql, type Statement, type Clock, type Logger, silentLogger } from "./ports.ts";
import { deleteMeta, getMeta, setMeta } from "./db.ts";
import { badRequest, conflict, forbidden, notFound, ServiceError, unauthorized } from "./errors.ts";
import {
  constantTimeEqualText,
  hashPassword,
  verifyPassword,
  type PasswordOptions,
} from "./passwords.ts";
import {
  createSession,
  deleteUserSessions,
  randomToken,
  resolveSession,
  planSessionCreation,
  SESSION_TOUCH_INTERVAL,
  SESSION_TTL,
} from "./sessions.ts";
import { withRetries } from "./write.ts";
import { loadSettings, saveSettings, settingsFromData } from "./settings.ts";
import { validateInput } from "./validation.ts";
import { permissionReadStatements, permissionsFromRows } from "./permissions.ts";
import { withdrawPendingOf, planSuggestionWithdrawal, type WithdrawalRow } from "./suggestions.ts";
import {
  forgetVolunteerName,
  planForgetVolunteerName,
  revokeInvitesBy,
  takeInvite,
  INVITE_COLUMNS,
  inviteUsableAt,
  type InviteRow,
} from "./team.ts";
import {
  administratorCount,
  DELETED_NAME,
  findUserByEmail,
  loadUser,
  normalizeEmail,
  requireUserRow,
  setupRequired,
  SETUP_STATE,
  USER_COLUMNS,
  userInfo,
  type UserRow,
  type IdentityRow,
  userInfoFromRows,
  ACCOUNT_COLUMNS,
  type AccountRow,
  userIdOf,
} from "./users.ts";

/** The `meta` key of the setup token, kept only while there is no administrator. */
export const SETUP_TOKEN = "setup_token";

/** The development account (design §5.13), on development instances only. */
export const DEV_EMAIL = "developer@localhost";
export const DEV_NAME = "Developer";

/** How long each kind of emailed link stays valid. */
export const EMAIL_TOKEN_TTL: Record<EmailPurpose, number> = {
  verify: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  signin: 60 * 60 * 1000,
};

/** How long a reset link an administrator creates stays valid: it is passed on by hand. */
export const RESET_LINK_TTL = 7 * 24 * 60 * 60 * 1000;

function signedIn(ctx: Context, userId: number, userAgent?: string): SignedIn {
  const session = createSession(ctx, userId, userAgent);
  return { ...session, user: userInfo(ctx.sql, requireUserRow(ctx.sql, userId)) };
}

function insertUser(
  ctx: Context,
  fields: {
    email: string | null;
    displayName: string;
    avatarUrl?: string | null;
    role: Role;
    languages?: string[] | null;
    passwordHash?: string | null;
    emailVerified?: boolean;
  },
): UserRow {
  const [row] = ctx.sql.query<UserRow>(
    `INSERT INTO users (email, display_name, avatar_url, role, languages, password_hash,
       email_verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${USER_COLUMNS}`,
    fields.email === null ? null : normalizeEmail(fields.email),
    fields.displayName.trim().slice(0, 80) || "New member",
    fields.avatarUrl ?? null,
    fields.role,
    fields.languages ? JSON.stringify(fields.languages) : null,
    fields.passwordHash ?? null,
    fields.emailVerified ? 1 : 0,
    ctx.clock(),
  );
  return row;
}

function refuseWhileSetupRequired(ctx: Context): void {
  if (setupRequired(ctx.sql)) {
    throw new ServiceError(
      "setup_required",
      "This instance has no administrator yet: open /setup and enter the operator's setup key first.",
    );
  }
}

// ---------------------------------------------------------------------------------------
// Email and password

export interface SignUpFields {
  email: string;
  displayName: string;
  invite?: string;
}

/** Creates an account (role none, or the invite's role) and signs it in. */
export function signUp(
  ctx: Context,
  fields: SignUpFields,
  passwordHash: string,
  userAgent?: string,
): SignedIn {
  refuseWhileSetupRequired(ctx);
  if (findUserByEmail(ctx.sql, fields.email) !== undefined) {
    throw conflict("An account with this email address exists already. Sign in instead.");
  }
  const user = insertUser(ctx, {
    email: fields.email,
    displayName: fields.displayName,
    role: "none",
    passwordHash,
  });
  if (fields.invite !== undefined) applyInvite(ctx, fields.invite, user.id);
  ctx.logger.info("Signed up", { userId: user.id, invite: fields.invite !== undefined });
  return signedIn(ctx, user.id, userAgent);
}

export async function completeSignUpAsync(
  sql: Sql,
  fields: SignUpFields,
  passwordHash: string,
  options: { clock?: Clock; userAgent?: string; logger?: Logger } = {},
): Promise<SignedIn> {
  const sessionId = randomToken();
  const email = normalizeEmail(fields.email);
  const result = await withRetries(
    sql,
    async () => {
      const [revision, administrators, existing, ids, invites] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        {
          sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND deleted_at IS NULL",
        },
        { sql: "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", params: [email] },
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users" },
        {
          sql: `SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = ?`,
          params: [fields.invite === undefined ? null : sha256Hex(fields.invite)],
        },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          administrators: Number(administrators[0].n),
          exists: existing.length > 0,
          id: Number(ids[0].id),
          invite: invites[0] as InviteRow | undefined,
          now: (options.clock ?? Date.now)(),
        },
      };
    },
    (state) => {
      if (state.administrators === 0)
        throw new ServiceError(
          "setup_required",
          "This instance has no administrator yet: open /setup and enter the operator's setup key first.",
        );
      if (state.exists)
        throw conflict("An account with this email address exists already. Sign in instead.");
      if (fields.invite !== undefined && !inviteUsableAt(state.invite, state.now))
        throw badRequest("This invite link isn't valid any more. Ask for a new one.");
      const invite = fields.invite === undefined ? undefined : state.invite;
      const role = invite?.role ?? "none";
      const languages = invite?.languages ?? null;
      const displayName = fields.displayName.trim().slice(0, 80) || "New member";
      const session = planSessionCreation(state.id, sessionId, state.now, options.userAgent);
      const statements: Statement[] = [
        {
          sql: "INSERT INTO users (id, email, display_name, role, languages, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          params: [state.id, email, displayName, role, languages, passwordHash, state.now],
        },
      ];
      if (invite !== undefined)
        statements.push({
          sql: "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?",
          params: [state.now, state.id, invite.id],
        });
      return {
        statements: [...statements, ...session.statements],
        result: {
          ...session.result,
          user: userInfoFromRows(
            {
              id: state.id,
              email,
              display_name: displayName,
              avatar_url: null,
              role,
              languages,
              created_at: state.now,
              deleted_at: null,
              email_verified: 0,
              has_password: 1,
              volunteer_status: null,
              volunteer_languages: null,
              volunteer_message: null,
              volunteer_requested_at: null,
              last_seen_at: state.now,
            },
            [],
          ),
        },
      };
    },
  );
  (options.logger ?? silentLogger).info("Signed up", {
    userId: result.user.id,
    invite: fields.invite !== undefined,
  });
  return result;
}

export async function signUpAsync(
  sql: Sql,
  request: SignUpRequest & { userAgent?: string },
  passwords: PasswordOptions,
  clock: Clock = Date.now,
  logger: Logger = silentLogger,
): Promise<SignedIn> {
  const hash = await hashPassword(request.password, passwords);
  return completeSignUpAsync(sql, request, hash, { clock, userAgent: request.userAgent, logger });
}

/** Gives a new account the role and languages of an invite, and uses the invite up. */
function applyInvite(ctx: Context, token: string, userId: number): void {
  const invite = takeInvite(ctx, token, userId);
  ctx.sql.run(
    "UPDATE users SET role = ?, languages = ? WHERE id = ?",
    invite.role,
    invite.languages === null ? null : JSON.stringify(invite.languages),
    userId,
  );
}

/** The password hash to check a sign-in against: null for unknown or passwordless accounts. */
export function passwordFor(ctx: Context, email: string): { userId: number; hash: string } | null {
  const user = findUserByEmail(ctx.sql, email);
  if (user === undefined || user.password_hash === null) return null;
  return { userId: user.id, hash: user.password_hash };
}

/** Internal sign-in input: this hash must never be included in an account response. */
export async function passwordForAsync(
  sql: Sql,
  email: string,
): Promise<{ userId: number; hash: string } | null> {
  const [rows] = await sql.read([
    {
      sql: "SELECT id, password_hash FROM users WHERE email = ? AND deleted_at IS NULL",
      params: [normalizeEmail(email)],
    },
  ]);
  const user = rows[0];
  if (user === undefined || user.password_hash === null) return null;
  return { userId: user.id as number, hash: user.password_hash as string };
}

/** The message for every failed sign-in, whatever failed. */
export const WRONG_CREDENTIALS = "The email address or the password is wrong.";

/**
 * Signs in a person whose password was checked against `checkedHash`, storing `newHash`
 * when the stored one used fewer iterations.
 */
export function completeSignIn(
  ctx: Context,
  userId: number,
  checkedHash: string,
  newHash: string | null,
  userAgent?: string,
): SignedIn {
  const user = loadUser(ctx.sql, userId);
  if (user === undefined || user.deleted_at !== null || user.password_hash !== checkedHash) {
    throw unauthorized(WRONG_CREDENTIALS);
  }
  if (newHash !== null) {
    ctx.sql.run("UPDATE users SET password_hash = ? WHERE id = ?", newHash, userId);
  }
  return signedIn(ctx, userId, userAgent);
}

/** Password verification stays outside the commit; every retry rechecks the exact hash. */
export async function completeSignInAsync(
  sql: Sql,
  userId: number,
  checkedHash: string,
  newHash: string | null,
  now: number,
  userAgent?: string,
): Promise<SignedIn> {
  const sessionId = randomToken();
  return withRetries(
    sql,
    async () => {
      const [revision, users, identities] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, params: [userId] },
        {
          sql: "SELECT provider, username FROM identities WHERE user_id = ? ORDER BY provider",
          params: [userId],
        },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: { user: users[0] as UserRow | undefined, identities: identities as IdentityRow[] },
      };
    },
    ({ user, identities }) => {
      const active = user !== undefined && user.deleted_at === null;
      if (!active || user.password_hash !== checkedHash) throw unauthorized(WRONG_CREDENTIALS);
      const session = planSessionCreation(userId, sessionId, now, userAgent);
      const statements: Statement[] =
        newHash === null
          ? []
          : [{ sql: "UPDATE users SET password_hash = ? WHERE id = ?", params: [newHash, userId] }];
      return {
        statements: [...statements, ...session.statements],
        result: {
          ...session.result,
          user: userInfoFromRows({ ...user, has_password: 1 }, identities),
        },
      };
    },
  );
}

export async function signInAsync(
  sql: Sql,
  request: SignInRequest & { userAgent?: string },
  passwords: PasswordOptions,
  clock: Clock = Date.now,
  logger: Logger = silentLogger,
): Promise<SignedIn> {
  const found = await passwordForAsync(sql, request.email);
  const checked = await verifyPassword(request.password, found?.hash ?? null, passwords);
  if (found === null || !checked.ok) {
    logger.info("Sign-in refused");
    throw unauthorized(WRONG_CREDENTIALS);
  }
  const rehash = checked.needsRehash ? await hashPassword(request.password, passwords) : null;
  return completeSignInAsync(sql, found.userId, found.hash, rehash, clock(), request.userAgent);
}

// ---------------------------------------------------------------------------------------
// First start (S6.3)

/**
 * While there is no administrator: the setup token to print, which is `token` (the
 * operator's `SETUP_KEY`) when given, or a random one made once and kept until setup.
 * Null once an administrator exists.
 */
export function ensureSetupToken(ctx: Context, token?: string): string | null {
  if (!setupRequired(ctx.sql)) {
    deleteMeta(ctx.sql, SETUP_TOKEN);
    return null;
  }
  if (token !== undefined) {
    if (getMeta(ctx.sql, SETUP_TOKEN) !== token) setMeta(ctx.sql, SETUP_TOKEN, token);
    return token;
  }
  const stored = getMeta(ctx.sql, SETUP_TOKEN);
  if (stored !== null) return stored;
  const created = randomToken();
  setMeta(ctx.sql, SETUP_TOKEN, created);
  return created;
}

export async function ensureSetupTokenAsync(
  sql: Sql,
  actor: Actor,
  token?: string,
): Promise<string | null> {
  if (actor.type !== "system") throw forbidden("Only the server may create setup tokens.");
  const proposed = token ?? randomToken();
  return withRetries(
    sql,
    async () => {
      const [revision, administrators, tokens] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        SETUP_STATE,
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          administrators: Number(administrators[0].n),
          stored: tokens[0]?.value as string | undefined,
        },
      };
    },
    ({ administrators, stored }) => {
      if (administrators !== 0)
        return {
          statements:
            stored === undefined
              ? []
              : [{ sql: "DELETE FROM meta WHERE key = ?", params: [SETUP_TOKEN] }],
          result: null,
        };
      const result = token === undefined ? (stored ?? proposed) : proposed;
      return {
        statements:
          stored === result
            ? []
            : [
                {
                  sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                  params: [SETUP_TOKEN, result],
                },
              ],
        result,
      };
    },
  );
}

/** Whether `token` is the setup token, compared in constant time; false after setup. */
export function validateSetupToken(ctx: Context, token: string): boolean {
  if (!setupRequired(ctx.sql)) return false;
  const stored = getMeta(ctx.sql, SETUP_TOKEN);
  return stored !== null && constantTimeEqualText(stored, token);
}

/** Administrator presence and the stored token are captured together. */
export async function validateSetupTokenAsync(sql: Sql, token: string): Promise<boolean> {
  const [administrators, tokens] = await sql.read([
    SETUP_STATE,
    { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
  ]);
  if (Number(administrators[0].n) !== 0) return false;
  const stored = tokens[0]?.value;
  return typeof stored === "string" && constantTimeEqualText(stored, token);
}

/**
 * Creates the first administrator and names the project, with the setup token; then the
 * token is gone, and setup is refused from then on.
 */
export function completeSetup(
  ctx: Context,
  request: Omit<SetupRequest, "password">,
  passwordHash: string,
  userAgent?: string,
): SignedIn {
  if (!setupRequired(ctx.sql)) throw forbidden("This instance is set up already.");
  if (!validateSetupToken(ctx, request.token)) {
    throw forbidden("The setup key is incorrect. Use the key from the deployment configuration.");
  }
  if (findUserByEmail(ctx.sql, request.email) !== undefined) {
    throw conflict("An account with this email address exists already.");
  }
  const user = insertUser(ctx, {
    email: request.email,
    displayName: request.displayName,
    role: "administrator",
    passwordHash,
  });
  const settings = loadSettings(ctx);
  saveSettings(ctx, {
    ...settings,
    name: request.projectName.trim(),
    sourceLanguage: request.sourceLanguage ?? settings.sourceLanguage,
  });
  deleteMeta(ctx.sql, SETUP_TOKEN);
  setMeta(ctx.sql, "setup_completed_at", String(ctx.clock()));
  ctx.logger.info("Setup complete: the first administrator is created", { userId: user.id });
  return signedIn(ctx, user.id, userAgent);
}

export async function completeSetupAsync(
  sql: Sql,
  request: Omit<SetupRequest, "password">,
  passwordHash: string,
  options: { model: string; clock?: Clock; userAgent?: string; logger?: Logger },
): Promise<SignedIn> {
  const sessionId = randomToken();
  const email = normalizeEmail(request.email);
  const result = await withRetries(
    sql,
    async () => {
      const [revision, administrators, tokens, existing, ids, settings] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        SETUP_STATE,
        { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
        { sql: "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", params: [email] },
        { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users" },
        { sql: "SELECT data FROM settings WHERE id = 1" },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          administrators: Number(administrators[0].n),
          token: tokens[0]?.value as string | undefined,
          exists: existing.length > 0,
          id: Number(ids[0].id),
          stored: (settings[0]?.data as string | undefined) ?? null,
          now: (options.clock ?? Date.now)(),
        },
      };
    },
    (state) => {
      if (state.administrators !== 0) throw forbidden("This instance is set up already.");
      if (state.token === undefined || !constantTimeEqualText(state.token, request.token))
        throw forbidden(
          "The setup key is incorrect. Use the key from the deployment configuration.",
        );
      if (state.exists) throw conflict("An account with this email address exists already.");
      const current = settingsFromData(state.stored, options.model);
      const settings = validateInput(ProjectSettings, {
        ...current,
        name: request.projectName.trim(),
        sourceLanguage: request.sourceLanguage ?? current.sourceLanguage,
      });
      const displayName = request.displayName.trim().slice(0, 80) || "New member";
      const session = planSessionCreation(state.id, sessionId, state.now, options.userAgent);
      return {
        statements: [
          {
            sql: "INSERT INTO users (id, email, display_name, role, password_hash, created_at) VALUES (?, ?, ?, 'administrator', ?, ?)",
            params: [state.id, email, displayName, passwordHash, state.now],
          },
          {
            sql: "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
            params: [JSON.stringify(settings)],
          },
          { sql: "DELETE FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
          {
            sql: "INSERT INTO meta (key, value) VALUES ('setup_completed_at', ?)",
            params: [String(state.now)],
          },
          ...session.statements,
        ],
        result: {
          ...session.result,
          user: userInfoFromRows(
            {
              id: state.id,
              email,
              display_name: displayName,
              avatar_url: null,
              role: "administrator",
              languages: null,
              created_at: state.now,
              deleted_at: null,
              email_verified: 0,
              has_password: 1,
              volunteer_status: null,
              volunteer_languages: null,
              volunteer_message: null,
              volunteer_requested_at: null,
              last_seen_at: state.now,
            },
            [],
          ),
        },
      };
    },
  );
  (options.logger ?? silentLogger).info("Setup complete: the first administrator is created", {
    userId: result.user.id,
  });
  return result;
}

export async function setupAsync(
  sql: Sql,
  request: SetupRequest & { userAgent?: string },
  passwords: PasswordOptions,
  options: { model: string; clock?: Clock; logger?: Logger },
): Promise<SignedIn> {
  // Refuse invalid setup keys before spending time on the password.
  const [administrators, tokens] = await sql.read([
    SETUP_STATE,
    { sql: "SELECT value FROM meta WHERE key = ?", params: [SETUP_TOKEN] },
  ]);
  if (Number(administrators[0].n) !== 0) throw forbidden("This instance is set up already.");
  const token = tokens[0]?.value;
  if (typeof token !== "string" || !constantTimeEqualText(token, request.token))
    throw forbidden("The setup key is incorrect. Use the key from the deployment configuration.");
  const hash = await hashPassword(request.password, passwords);
  return completeSetupAsync(sql, request, hash, { ...options, userAgent: request.userAgent });
}

/** The development account (an administrator without a password), created if needed. */
export function ensureDevAccount(ctx: Context): UserRow {
  const existing = findUserByEmail(ctx.sql, DEV_EMAIL);
  if (existing !== undefined) {
    if (existing.role !== "administrator") {
      ctx.sql.run("UPDATE users SET role = 'administrator' WHERE id = ?", existing.id);
    }
    return requireUserRow(ctx.sql, existing.id);
  }
  return insertUser(ctx, {
    email: DEV_EMAIL,
    displayName: DEV_NAME,
    role: "administrator",
    emailVerified: true,
  });
}

/** Signs in the development account. */
export function devSignIn(ctx: Context, userAgent?: string): SignedIn {
  return signedIn(ctx, ensureDevAccount(ctx).id, userAgent);
}

async function readDevelopmentAccount(sql: Sql) {
  const [revision, users, ids, identities] = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    {
      sql: `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE email = ? AND deleted_at IS NULL`,
      params: [DEV_EMAIL],
    },
    { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users" },
    {
      sql: "SELECT provider, username FROM identities WHERE user_id = (SELECT id FROM users WHERE email = ? AND deleted_at IS NULL) ORDER BY provider",
      params: [DEV_EMAIL],
    },
  ]);
  return {
    revision: Number(revision[0].revision),
    state: {
      user: users[0] as AccountRow | undefined,
      nextId: Number(ids[0].id),
      identities: identities as IdentityRow[],
    },
  };
}

function planDevelopmentAccount(
  state: { user: AccountRow | undefined; nextId: number; identities: IdentityRow[] },
  now: number,
): { statements: Statement[]; result: UserInfo } {
  const row: AccountRow = state.user ?? {
    id: state.nextId,
    email: DEV_EMAIL,
    display_name: DEV_NAME,
    avatar_url: null,
    role: "administrator",
    languages: null,
    created_at: now,
    deleted_at: null,
    email_verified: 1,
    has_password: 0,
    volunteer_status: null,
    volunteer_languages: null,
    volunteer_message: null,
    volunteer_requested_at: null,
    last_seen_at: null,
  };
  const statements: Statement[] = [];
  if (state.user === undefined)
    statements.push({
      sql: "INSERT INTO users (id, email, display_name, role, email_verified, created_at) VALUES (?, ?, ?, 'administrator', 1, ?)",
      params: [row.id, DEV_EMAIL, DEV_NAME, now],
    });
  else if (row.role !== "administrator")
    statements.push({
      sql: "UPDATE users SET role = 'administrator' WHERE id = ?",
      params: [row.id],
    });
  return {
    statements,
    result: userInfoFromRows({ ...row, role: "administrator" }, state.identities),
  };
}

export async function ensureDevAccountAsync(
  sql: Sql,
  actor: Actor,
  dev: boolean,
  now: number,
): Promise<UserInfo> {
  if (actor.type !== "system") throw forbidden();
  if (!dev) throw forbidden("The developer account only exists on development instances.");
  return withRetries(
    sql,
    () => readDevelopmentAccount(sql),
    (state) => planDevelopmentAccount(state, now),
  );
}

export async function devSignInAsync(
  sql: Sql,
  actor: Actor,
  dev: boolean,
  now: number,
  userAgent?: string,
): Promise<SignedIn> {
  if (actor.type !== "system") throw forbidden();
  if (!dev) throw forbidden("The developer account only exists on development instances.");
  const sessionId = randomToken();
  return withRetries(
    sql,
    () => readDevelopmentAccount(sql),
    (state) => {
      const account = planDevelopmentAccount(state, now);
      const session = planSessionCreation(account.result.id, sessionId, now, userAgent);
      return {
        statements: [...account.statements, ...session.statements],
        result: { ...session.result, user: account.result },
      };
    },
  );
}

// ---------------------------------------------------------------------------------------
// GitHub and Discord (S6.4)

/**
 * Signs in with a provider's account: the account it is linked to; or, with
 * `linkToUserId`, links it to that person; or, when the provider verified the email
 * address and a person has it, verified too, links it to them (`conflict` when their
 * address isn't verified: they sign in and link it themselves); or else creates an account
 * (role none, or the invite's role).
 */
export function signInWithIdentity(ctx: Context, fields: IdentityInput): IdentityResult {
  const { sql } = ctx;
  if (
    fields.linkSessionId !== undefined &&
    resolveSession(ctx, fields.linkSessionId)?.userId !== fields.linkToUserId
  ) {
    throw unauthorized("Your session has ended. Sign in again before linking an account.");
  }
  const [linked] = sql.query<{ id: number; user_id: number }>(
    "SELECT id, user_id FROM identities WHERE provider = ? AND subject = ?",
    fields.provider,
    fields.subject,
  );
  const email = fields.email ? normalizeEmail(fields.email) : null;
  let userId: number;
  let created = false;
  if (linked !== undefined) {
    if (fields.linkToUserId !== undefined && fields.linkToUserId !== linked.user_id) {
      throw conflict(
        `This ${providerName(fields.provider)} account is linked to another Quaso account.`,
      );
    }
    userId = linked.user_id;
    sql.run(
      "UPDATE identities SET username = ?, email = ?, avatar_url = ? WHERE id = ?",
      fields.username ?? null,
      email,
      fields.avatarUrl ?? null,
      linked.id,
    );
  } else {
    if (fields.linkToUserId !== undefined) {
      userId = requireUserRow(sql, fields.linkToUserId).id;
    } else {
      const byEmail =
        email !== null && fields.emailVerified ? findUserByEmail(sql, email) : undefined;
      if (byEmail !== undefined && byEmail.email_verified !== 1) {
        // Nobody proved they own that account's address: linking would share the account,
        // and whatever role it gets, with whoever created it (a pre-account hijack).
        throw conflict(
          "An account with this email address exists, but its address isn't verified. " +
            `Sign in to it, then link ${providerName(fields.provider)} on your account page.`,
        );
      }
      if (byEmail !== undefined) {
        userId = byEmail.id;
      } else {
        refuseWhileSetupRequired(ctx);
        // An unverified address isn't taken: it would lock its real owner out.
        const free = email !== null && fields.emailVerified === true;
        const user = insertUser(ctx, {
          email: free ? email : null,
          displayName: fields.displayName || fields.username || "New member",
          avatarUrl: fields.avatarUrl ?? null,
          role: "none",
          emailVerified: free,
        });
        userId = user.id;
        created = true;
        if (fields.invite !== undefined) applyInvite(ctx, fields.invite, userId);
      }
    }
    sql.run(
      `INSERT INTO identities (user_id, provider, subject, username, email, avatar_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId,
      fields.provider,
      fields.subject,
      fields.username ?? null,
      email,
      fields.avatarUrl ?? null,
      ctx.clock(),
    );
  }
  const user = requireUserRow(sql, userId);
  if (user.avatar_url === null && fields.avatarUrl) {
    sql.run("UPDATE users SET avatar_url = ? WHERE id = ?", fields.avatarUrl, userId);
  }
  if (email !== null && fields.emailVerified && user.email === email && user.email_verified === 0) {
    sql.run("UPDATE users SET email_verified = 1 WHERE id = ?", userId);
  }
  if (fields.linkToUserId !== undefined) {
    return {
      sessionId: null,
      expiresAt: null,
      user: userInfo(sql, loadUser(sql, userId)!),
      created,
    };
  }
  return { ...signedIn(ctx, userId, fields.userAgent), created };
}

export async function signInWithIdentityAsync(
  sql: Sql,
  actor: Actor,
  fields: IdentityInput,
  clock: Clock = Date.now,
): Promise<IdentityResult> {
  if (actor.type !== "system") throw forbidden();
  const sessionId = randomToken();
  const email = fields.email ? normalizeEmail(fields.email) : null;
  const selectedUsers =
    "id IN (SELECT user_id FROM identities WHERE provider = ? AND subject = ?) OR id = ? OR (email = ? AND deleted_at IS NULL)";
  const userParams = [
    fields.provider,
    fields.subject,
    fields.linkToUserId ?? null,
    fields.emailVerified ? email : null,
  ];
  return withRetries(
    sql,
    async () => {
      const [revision, linked, users, identities, ids, administrators, invites, sessions] =
        await sql.read([
          {
            sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
          },
          {
            sql: "SELECT id, user_id FROM identities WHERE provider = ? AND subject = ?",
            params: [fields.provider, fields.subject],
          },
          {
            sql: `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE ${selectedUsers}`,
            params: userParams,
          },
          {
            sql: `SELECT id, user_id, provider, username FROM identities WHERE user_id IN (SELECT id FROM users WHERE ${selectedUsers}) ORDER BY provider`,
            params: userParams,
          },
          { sql: "SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users" },
          {
            sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND deleted_at IS NULL",
          },
          {
            sql: `SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = ?`,
            params: [fields.invite === undefined ? null : sha256Hex(fields.invite)],
          },
          {
            sql: "SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id_hash = ?",
            params: [fields.linkSessionId === undefined ? null : sha256Hex(fields.linkSessionId)],
          },
        ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          linked: linked[0] as { id: number; user_id: number } | undefined,
          users: users as AccountRow[],
          identities: identities as (IdentityRow & { id: number; user_id: number })[],
          nextId: Number(ids[0].id),
          administrators: Number(administrators[0].n),
          invite: invites[0] as InviteRow | undefined,
          session: sessions[0] as
            | { user_id: number; expires_at: number; last_seen_at: number }
            | undefined,
          now: clock(),
        },
      };
    },
    (state): { statements: Statement[]; result: IdentityResult } => {
      const statements: Statement[] = [];
      if (fields.linkSessionId !== undefined) {
        const session = state.session;
        const target = state.users.find((row) => row.id === fields.linkToUserId);
        const activeTarget = target !== undefined && target.deleted_at === null;
        const currentSession =
          session !== undefined &&
          session.user_id === fields.linkToUserId &&
          session.expires_at > state.now;
        if (!activeTarget || !currentSession)
          throw unauthorized("Your session has ended. Sign in again before linking an account.");
        if (state.now - session.last_seen_at >= SESSION_TOUCH_INTERVAL)
          statements.push(
            {
              sql: "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?",
              params: [state.now, state.now + SESSION_TTL, sha256Hex(fields.linkSessionId)],
            },
            {
              sql: "UPDATE users SET last_seen_at = ? WHERE id = ?",
              params: [state.now, target.id],
            },
          );
      }
      if (
        state.linked !== undefined &&
        fields.linkToUserId !== undefined &&
        fields.linkToUserId !== state.linked.user_id
      )
        throw conflict(
          `This ${providerName(fields.provider)} account is linked to another Quaso account.`,
        );
      let user: AccountRow | undefined;
      const linked = state.linked;
      if (linked !== undefined) user = state.users.find((row) => row.id === linked.user_id);
      else if (fields.linkToUserId !== undefined)
        user = state.users.find((row) => row.id === fields.linkToUserId);
      else if (email !== null && fields.emailVerified) {
        user = state.users.find((row) => row.email === email && row.deleted_at === null);
        // Linking to an unverified address would share the account with whoever registered it.
        if (user !== undefined && user.email_verified !== 1)
          throw conflict(
            "An account with this email address exists, but its address isn't verified. " +
              `Sign in to it, then link ${providerName(fields.provider)} on your account page.`,
          );
      }
      const existingId = state.linked?.user_id ?? fields.linkToUserId;
      if (existingId !== undefined && (user === undefined || user.deleted_at !== null))
        throw notFound(`User ${existingId}`);
      const created = user === undefined;
      if (user === undefined) {
        if (state.administrators === 0)
          throw new ServiceError(
            "setup_required",
            "This instance has no administrator yet: open /setup and enter the operator's setup key first.",
          );
        if (fields.invite !== undefined && !inviteUsableAt(state.invite, state.now))
          throw badRequest("This invite link isn't valid any more. Ask for a new one.");
        const invite = fields.invite === undefined ? undefined : state.invite;
        const verifiedEmail = email !== null && fields.emailVerified === true;
        const displayName =
          (fields.displayName || fields.username || "New member").trim().slice(0, 80) ||
          "New member";
        user = {
          id: state.nextId,
          email: verifiedEmail ? email : null,
          display_name: displayName,
          avatar_url: fields.avatarUrl ?? null,
          role: invite?.role ?? "none",
          languages: invite?.languages ?? null,
          created_at: state.now,
          deleted_at: null,
          email_verified: verifiedEmail ? 1 : 0,
          has_password: 0,
          volunteer_status: null,
          volunteer_languages: null,
          volunteer_message: null,
          volunteer_requested_at: null,
          last_seen_at: null,
        };
        statements.push({
          sql: "INSERT INTO users (id, email, display_name, avatar_url, role, languages, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            user.id,
            user.email,
            user.display_name,
            user.avatar_url,
            user.role,
            user.languages,
            user.email_verified,
            state.now,
          ],
        });
        if (invite !== undefined)
          statements.push({
            sql: "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?",
            params: [state.now, user.id, invite.id],
          });
      }
      const account = { ...user };
      const identities: IdentityRow[] = state.identities
        .filter((row) => row.user_id === account.id)
        .map((row) =>
          row.id === state.linked?.id
            ? { provider: row.provider, username: fields.username ?? null }
            : row,
        );
      if (state.linked === undefined) {
        statements.push({
          sql: "INSERT INTO identities (user_id, provider, subject, username, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          params: [
            account.id,
            fields.provider,
            fields.subject,
            fields.username ?? null,
            email,
            fields.avatarUrl ?? null,
            state.now,
          ],
        });
        identities.push({ provider: fields.provider, username: fields.username ?? null });
        identities.sort((a, b) => a.provider.localeCompare(b.provider));
      } else
        statements.push({
          sql: "UPDATE identities SET username = ?, email = ?, avatar_url = ? WHERE id = ?",
          params: [fields.username ?? null, email, fields.avatarUrl ?? null, state.linked.id],
        });
      if (account.avatar_url === null && fields.avatarUrl) {
        statements.push({
          sql: "UPDATE users SET avatar_url = ? WHERE id = ?",
          params: [fields.avatarUrl, account.id],
        });
        account.avatar_url = fields.avatarUrl;
      }
      if (
        email !== null &&
        fields.emailVerified &&
        account.email === email &&
        account.email_verified === 0
      ) {
        statements.push({
          sql: "UPDATE users SET email_verified = 1 WHERE id = ?",
          params: [account.id],
        });
        account.email_verified = 1;
      }
      const info = userInfoFromRows(account, identities);
      if (fields.linkToUserId !== undefined)
        return { statements, result: { sessionId: null, expiresAt: null, user: info, created } };
      const session = planSessionCreation(account.id, sessionId, state.now, fields.userAgent);
      return {
        statements: [...statements, ...session.statements],
        result: { ...session.result, user: info, created },
      };
    },
  );
}

/** Unlinks a provider, unless it is the account's last way to sign in. */
export function unlinkIdentity(ctx: Context, userId: number, provider: IdentityProvider): UserInfo {
  const user = requireUserRow(ctx.sql, userId);
  const identities = ctx.sql.query<{ provider: string }>(
    "SELECT provider FROM identities WHERE user_id = ?",
    userId,
  );
  if (!identities.some((identity) => identity.provider === provider)) {
    throw notFound(`A linked ${providerName(provider)} account`);
  }
  const hasPassword = user.password_hash !== null && user.email !== null;
  if (!hasPassword && identities.length === 1) {
    throw badRequest(
      `Set a password first: ${providerName(provider)} is this account's only way to sign in.`,
    );
  }
  ctx.sql.run("DELETE FROM identities WHERE user_id = ? AND provider = ?", userId, provider);
  return userInfo(ctx.sql, requireUserRow(ctx.sql, userId));
}

export async function unlinkIdentityAsync(
  sql: Sql,
  actor: Actor,
  provider: IdentityProvider,
): Promise<UserInfo> {
  const id = actor.type === "user" ? actor.userId : null;
  return withRetries(
    sql,
    async () => {
      const [revision, users, identities, ...permissionRows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        {
          sql: `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`,
          params: [id],
        },
        {
          sql: "SELECT provider, username FROM identities WHERE user_id = ? ORDER BY provider",
          params: [id],
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as AccountRow | undefined,
          identities: identities as IdentityRow[],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ user, identities, permissions }) => {
      permissions.require("account");
      const userId = userIdOf(actor);
      if (user === undefined) throw notFound(`User ${userId}`);
      if (!identities.some((identity) => identity.provider === provider))
        throw notFound(`A linked ${providerName(provider)} account`);
      const hasPassword = user.has_password === 1 && user.email !== null;
      if (!hasPassword && identities.length === 1)
        throw badRequest(
          `Set a password first: ${providerName(provider)} is this account's only way to sign in.`,
        );
      return {
        statements: [
          {
            sql: "DELETE FROM identities WHERE user_id = ? AND provider = ?",
            params: [userId, provider],
          },
        ],
        result: userInfoFromRows(
          user,
          identities.filter((identity) => identity.provider !== provider),
        ),
      };
    },
  );
}

function providerName(provider: IdentityProvider): string {
  return provider === "github" ? "GitHub" : "Discord";
}

// ---------------------------------------------------------------------------------------
// Links by email (S6.4), and reset links from administrators

function insertEmailToken(
  ctx: Context,
  userId: number,
  email: string,
  purpose: EmailPurpose,
  ttl: number,
): EmailTokenResult {
  const plan = planEmailTokenCreation(userId, email, purpose, ttl, ctx.clock(), randomToken());
  for (const statement of plan.statements) ctx.sql.run(statement.sql, ...(statement.params ?? []));
  return plan.result;
}

function planEmailTokenCreation(
  userId: number,
  email: string,
  purpose: EmailPurpose,
  ttl: number,
  now: number,
  token: string,
): { statements: Statement[]; result: EmailTokenResult } {
  const expiresAt = now + ttl;
  return {
    statements: [
      { sql: "DELETE FROM email_tokens WHERE expires_at <= ?", params: [now] },
      {
        sql: "INSERT INTO email_tokens (token_hash, user_id, email, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [sha256Hex(token), userId, email, purpose, expiresAt, now],
      },
    ],
    result: { token, userId, email, expiresAt },
  };
}

/**
 * A link's token for the person with this email address, or null when there is none (the
 * HTTP API answers the same either way, so it never tells whether an address has an account).
 */
export function createEmailToken(
  ctx: Context,
  email: string,
  purpose: EmailPurpose,
): EmailTokenResult | null {
  const user = findUserByEmail(ctx.sql, email);
  if (user === undefined || user.email === null) return null;
  return insertEmailToken(ctx, user.id, user.email, purpose, EMAIL_TOKEN_TTL[purpose]);
}

export async function createEmailTokenAsync(
  sql: Sql,
  actor: Actor,
  email: string,
  purpose: EmailPurpose,
  clock: Clock = Date.now,
): Promise<EmailTokenResult | null> {
  if (actor.type !== "system") throw forbidden();
  const token = randomToken();
  return withRetries(
    sql,
    async () => {
      const [revision, users] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        {
          sql: "SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL",
          params: [normalizeEmail(email)],
        },
      ]);
      return {
        revision: Number(revision[0].revision),
        state: { user: users[0] as { id: number; email: string } | undefined, now: clock() },
      };
    },
    ({ user, now }) =>
      user === undefined
        ? { statements: [], result: null }
        : planEmailTokenCreation(
            user.id,
            user.email,
            purpose,
            EMAIL_TOKEN_TTL[purpose],
            now,
            token,
          ),
  );
}

const INVALID_LINK = "This link isn't valid, or has expired or been used. Ask for a new one.";

type EmailLinkRow = { email: string; expires_at: number; used_at: number | null };
type EmailLinkState = {
  link: EmailLinkRow | undefined;
  user: AccountRow | undefined;
  identities: IdentityRow[];
  now: number;
};

async function readEmailLink(sql: Sql, token: string, purpose: EmailPurpose, clock: Clock) {
  const params = [sha256Hex(token), purpose];
  const [revision, links, users, identities] = await sql.read([
    {
      sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
    },
    {
      sql: "SELECT email, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?",
      params,
    },
    {
      sql: `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = (SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ?)`,
      params,
    },
    {
      sql: "SELECT provider, username FROM identities WHERE user_id = (SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ?) ORDER BY provider",
      params,
    },
  ]);
  return {
    revision: Number(revision[0].revision),
    state: {
      link: links[0] as EmailLinkRow | undefined,
      user: users[0] as AccountRow | undefined,
      identities: identities as IdentityRow[],
      now: clock(),
    },
  };
}

function planEmailLinkUse(state: EmailLinkState, token: string, purpose: EmailPurpose) {
  const { link, user, now } = state;
  const usable = link !== undefined && link.used_at === null && link.expires_at > now;
  const active = user !== undefined && user.deleted_at === null;
  if (!usable || !active) throw badRequest(INVALID_LINK);
  const currentEmail = purpose === "verify" ? user.email : (user.email ?? "");
  if (link.email !== currentEmail) throw badRequest(INVALID_LINK);
  const statements: Statement[] = [
    {
      sql: "UPDATE email_tokens SET used_at = ? WHERE token_hash = ?",
      params: [now, sha256Hex(token)],
    },
  ];
  return { user, now, statements };
}

/** Uses up a link's token: its person and address, or `bad_request`. */
function useEmailToken(
  ctx: Context,
  token: string,
  purpose: EmailPurpose,
): { user: UserRow; email: string } {
  const hash = sha256Hex(token);
  const [row] = ctx.sql.query<{
    user_id: number;
    email: string;
    expires_at: number;
    used_at: number | null;
  }>(
    "SELECT user_id, email, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?",
    hash,
    purpose,
  );
  const now = ctx.clock();
  if (row === undefined || row.used_at !== null || row.expires_at <= now) {
    throw badRequest(INVALID_LINK);
  }
  const user = loadUser(ctx.sql, row.user_id);
  if (user === undefined || user.deleted_at !== null) throw badRequest(INVALID_LINK);
  // Reset and sign-in links work only for the address they were sent to (an administrator's
  // reset link for an account without one has ""). Verification links are checked by
  // `verifyEmail`.
  if (purpose !== "verify" && row.email !== (user.email ?? "")) throw badRequest(INVALID_LINK);
  ctx.sql.run("UPDATE email_tokens SET used_at = ? WHERE token_hash = ?", now, hash);
  return { user, email: row.email };
}

/**
 * Voids a person's unused links: all of them when the address changes, the reset and
 * sign-in links when the password changes (a link sent before must not undo the change).
 */
function voidLinks(ctx: Context, userId: number, which: "all" | "access"): void {
  ctx.sql.run(
    `DELETE FROM email_tokens WHERE user_id = ? AND used_at IS NULL${
      which === "all" ? "" : " AND purpose IN ('reset', 'signin')"
    }`,
    userId,
  );
}

/** Verifies the address a verification link was sent to, if it is still the account's. */
export function verifyEmail(ctx: Context, token: string): void {
  const { user, email } = useEmailToken(ctx, token, "verify");
  if (user.email !== email) throw badRequest(INVALID_LINK);
  ctx.sql.run("UPDATE users SET email_verified = 1 WHERE id = ?", user.id);
}

export async function verifyEmailAsync(
  sql: Sql,
  token: string,
  clock: Clock = Date.now,
): Promise<{ ok: true }> {
  return withRetries(
    sql,
    () => readEmailLink(sql, token, "verify", clock),
    (state) => {
      const use = planEmailLinkUse(state, token, "verify");
      return {
        statements: [
          ...use.statements,
          { sql: "UPDATE users SET email_verified = 1 WHERE id = ?", params: [use.user.id] },
        ],
        result: { ok: true as const },
      };
    },
  );
}

/**
 * Sets a new password from a reset link, signs out every session, voids the other reset
 * and sign-in links, and signs in.
 */
export function resetPassword(
  ctx: Context,
  token: string,
  passwordHash: string,
  userAgent?: string,
): SignedIn {
  const { user } = useEmailToken(ctx, token, "reset");
  // An unverified address may have been registered by someone else. Recovery must
  // remove their linked sign-in methods as well as their password and sessions.
  if (user.email !== null && user.email_verified === 0) {
    ctx.sql.run("DELETE FROM identities WHERE user_id = ?", user.id);
    ctx.sql.run("UPDATE users SET email_verified = 1 WHERE id = ?", user.id);
  }
  ctx.sql.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, user.id);
  deleteUserSessions(ctx, user.id);
  voidLinks(ctx, user.id, "access");
  ctx.logger.info("Password reset", { userId: user.id });
  return signedIn(ctx, user.id, userAgent);
}

export async function completePasswordResetAsync(
  sql: Sql,
  token: string,
  passwordHash: string,
  options: { clock?: Clock; userAgent?: string; logger?: Logger } = {},
): Promise<SignedIn> {
  const sessionId = randomToken();
  const result = await withRetries(
    sql,
    () => readEmailLink(sql, token, "reset", options.clock ?? Date.now),
    (state) => {
      const use = planEmailLinkUse(state, token, "reset");
      const recovery = use.user.email !== null && use.user.email_verified === 0;
      const statements = [...use.statements];
      if (recovery)
        statements.push(
          { sql: "DELETE FROM identities WHERE user_id = ?", params: [use.user.id] },
          { sql: "UPDATE users SET email_verified = 1 WHERE id = ?", params: [use.user.id] },
        );
      statements.push(
        {
          sql: "UPDATE users SET password_hash = ? WHERE id = ?",
          params: [passwordHash, use.user.id],
        },
        { sql: "DELETE FROM sessions WHERE user_id = ?", params: [use.user.id] },
        {
          sql: "DELETE FROM email_tokens WHERE user_id = ? AND used_at IS NULL AND purpose IN ('reset', 'signin')",
          params: [use.user.id],
        },
      );
      const session = planSessionCreation(use.user.id, sessionId, use.now, options.userAgent);
      return {
        statements: [...statements, ...session.statements],
        result: {
          ...session.result,
          user: userInfoFromRows(
            {
              ...use.user,
              email_verified: recovery ? 1 : use.user.email_verified,
              has_password: 1,
            },
            recovery ? [] : state.identities,
          ),
        },
      };
    },
  );
  (options.logger ?? silentLogger).info("Password reset", { userId: result.user.id });
  return result;
}

export async function resetPasswordAsync(
  sql: Sql,
  request: ResetPasswordRequest & { token: string; userAgent?: string },
  passwords: PasswordOptions,
  clock: Clock = Date.now,
  logger: Logger = silentLogger,
): Promise<SignedIn> {
  const hash = await hashPassword(request.password, passwords);
  return completePasswordResetAsync(sql, request.token, hash, {
    clock,
    userAgent: request.userAgent,
    logger,
  });
}

/** Signs in with a link sent to an already verified address. */
export function signInWithEmailLink(ctx: Context, token: string, userAgent?: string): SignedIn {
  const { user } = useEmailToken(ctx, token, "signin");
  if (user.email_verified === 0) {
    throw forbidden(
      "This account's email address is unverified. Request a password reset to recover it safely.",
    );
  }
  return signedIn(ctx, user.id, userAgent);
}

export async function signInWithEmailLinkAsync(
  sql: Sql,
  token: string,
  clock: Clock = Date.now,
  userAgent?: string,
): Promise<SignedIn> {
  const sessionId = randomToken();
  return withRetries(
    sql,
    () => readEmailLink(sql, token, "signin", clock),
    (state) => {
      const use = planEmailLinkUse(state, token, "signin");
      if (use.user.email_verified === 0)
        throw forbidden(
          "This account's email address is unverified. Request a password reset to recover it safely.",
        );
      const session = planSessionCreation(use.user.id, sessionId, use.now, userAgent);
      return {
        statements: [...use.statements, ...session.statements],
        result: { ...session.result, user: userInfoFromRows(use.user, state.identities) },
      };
    },
  );
}

/** A password reset link for someone, for teams without an email service (S6.4). */
export function createResetLink(ctx: Context, userId: number, baseUrl: string): ResetLink {
  const user = requireUserRow(ctx.sql, userId);
  const created = insertEmailToken(ctx, user.id, user.email ?? "", "reset", RESET_LINK_TTL);
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/reset-password?token=${created.token}`,
    expiresAt: created.expiresAt,
  };
}

export async function createResetLinkAsync(
  sql: Sql,
  actor: Actor,
  userId: number,
  baseUrl: string,
  clock: Clock = Date.now,
  logger: Logger = silentLogger,
): Promise<ResetLink> {
  const token = randomToken();
  const created = await withRetries(
    sql,
    async () => {
      const [revision, users, ...permissionRows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        { sql: "SELECT email FROM users WHERE id = ? AND deleted_at IS NULL", params: [userId] },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as { email: string | null } | undefined,
          permissions: permissionsFromRows(actor, permissionRows),
          now: clock(),
        },
      };
    },
    ({ user, permissions, now }) => {
      permissions.require("team");
      if (user === undefined) throw notFound(`User ${userId}`);
      return planEmailTokenCreation(userId, user.email ?? "", "reset", RESET_LINK_TTL, now, token);
    },
  );
  logger.info("Reset link created", { userId });
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/reset-password?token=${created.token}`,
    expiresAt: created.expiresAt,
  };
}

// ---------------------------------------------------------------------------------------
// The account (S6.10)

export interface AccountChange {
  displayName?: string;
  email?: string;
  passwordHash?: string;
  /** The session making the change: it stays signed in when the password changes. */
  keepSessionId?: string;
}

/**
 * Changes the display name, the email address (which is then unverified, and the links
 * sent before void) or the password (which signs out the other sessions and voids the
 * reset and sign-in links sent before). `checkedHash` is the password hash the current
 * password was checked against (null: the account had none), or undefined when no check
 * was needed; a password changed meanwhile fails.
 */
export function updateAccount(
  ctx: Context,
  userId: number,
  change: AccountChange,
  checkedHash: string | null | undefined,
): UserInfo {
  const { sql } = ctx;
  const user = requireUserRow(sql, userId);
  if (checkedHash !== undefined && user.password_hash !== checkedHash) {
    throw forbidden("The current password is wrong.");
  }
  if (change.displayName !== undefined) {
    sql.run("UPDATE users SET display_name = ? WHERE id = ?", change.displayName.trim(), userId);
  }
  if (change.email !== undefined) {
    const email = normalizeEmail(change.email);
    if (email !== user.email) {
      const other = findUserByEmail(sql, email);
      if (other !== undefined) throw conflict("Another account has this email address.");
      sql.run("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?", email, userId);
      voidLinks(ctx, userId, "all");
    }
  }
  if (change.passwordHash !== undefined) {
    sql.run("UPDATE users SET password_hash = ? WHERE id = ?", change.passwordHash, userId);
    deleteUserSessions(ctx, userId, change.keepSessionId);
    voidLinks(ctx, userId, "access");
  }
  return userInfo(sql, requireUserRow(sql, userId));
}

export async function completeAccountUpdateAsync(
  sql: Sql,
  actor: Actor,
  change: AccountChange,
  checkedHash?: string | null,
): Promise<UserInfo> {
  const id = actor.type === "user" ? actor.userId : null;
  const email = change.email === undefined ? undefined : normalizeEmail(change.email);
  return withRetries(
    sql,
    async () => {
      const [revision, users, identities, duplicates, ...permissionRows] = await sql.read([
        {
          sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
        },
        {
          sql: `SELECT ${ACCOUNT_COLUMNS}${checkedHash === undefined ? "" : ", password_hash"} FROM users WHERE id = ? AND deleted_at IS NULL`,
          params: [id],
        },
        {
          sql: "SELECT provider, username FROM identities WHERE user_id = ? ORDER BY provider",
          params: [id],
        },
        {
          sql: "SELECT id FROM users WHERE email = ? AND id <> ? AND deleted_at IS NULL",
          params: [email ?? null, id],
        },
        ...permissionReadStatements(actor),
      ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as (AccountRow & { password_hash?: string | null }) | undefined,
          identities: identities as IdentityRow[],
          duplicate: duplicates.length > 0,
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ user, identities, duplicate, permissions }) => {
      permissions.require("account");
      const userId = userIdOf(actor);
      if (user === undefined) throw notFound(`User ${userId}`);
      if (checkedHash !== undefined && user.password_hash !== checkedHash)
        throw forbidden("The current password is wrong.");
      const statements: Statement[] = [];
      const updated = { ...user };
      const name = change.displayName?.trim();
      if (name !== undefined && name !== user.display_name) {
        statements.push({
          sql: "UPDATE users SET display_name = ? WHERE id = ?",
          params: [name, userId],
        });
        updated.display_name = name;
      }
      const emailChanged = email !== undefined && email !== user.email;
      if (emailChanged) {
        if (duplicate) throw conflict("Another account has this email address.");
        statements.push({
          sql: "UPDATE users SET email = ?, email_verified = 0 WHERE id = ?",
          params: [email, userId],
        });
        updated.email = email;
        updated.email_verified = 0;
      }
      if (change.passwordHash !== undefined) {
        statements.push(
          {
            sql: "UPDATE users SET password_hash = ? WHERE id = ?",
            params: [change.passwordHash, userId],
          },
          change.keepSessionId === undefined
            ? { sql: "DELETE FROM sessions WHERE user_id = ?", params: [userId] }
            : {
                sql: "DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?",
                params: [userId, sha256Hex(change.keepSessionId)],
              },
        );
        updated.has_password = 1;
      }
      if (emailChanged || change.passwordHash !== undefined)
        statements.push({
          sql: `DELETE FROM email_tokens WHERE user_id = ? AND used_at IS NULL${emailChanged ? "" : " AND purpose IN ('reset', 'signin')"}`,
          params: [userId],
        });
      return { statements, result: userInfoFromRows(updated, identities) };
    },
  );
}

export async function updateAccountAsync(
  sql: Sql,
  actor: Actor,
  request: UpdateAccountRequest & { sessionId?: string },
  passwords?: PasswordOptions,
): Promise<UserInfo> {
  const sensitive = request.email !== undefined || request.password !== undefined;
  if (!sensitive)
    return completeAccountUpdateAsync(sql, actor, { displayName: request.displayName });
  const id = actor.type === "user" ? actor.userId : null;
  const [users, ...permissionRows] = await sql.read([
    { sql: "SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL", params: [id] },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("account");
  const userId = userIdOf(actor);
  if (users[0] === undefined) throw notFound(`User ${userId}`);
  if (passwords === undefined)
    throw new ServiceError("internal", "Password authentication is not configured.");
  const checkedHash = users[0].password_hash as string | null;
  if (checkedHash !== null) {
    if (request.currentPassword === undefined)
      throw badRequest("Enter your current password to change your email address or password.");
    const checked = await verifyPassword(request.currentPassword, checkedHash, passwords);
    if (!checked.ok) throw forbidden("The current password is wrong.");
  }
  const passwordHash =
    request.password === undefined ? undefined : await hashPassword(request.password, passwords);
  return completeAccountUpdateAsync(
    sql,
    actor,
    {
      displayName: request.displayName,
      email: request.email,
      passwordHash,
      keepSessionId: request.sessionId,
    },
    checkedHash,
  );
}

/**
 * Deletes an account (OPS-3): its email address, password hash, sign-in methods, sessions,
 * links, unused invites (revoked) and pending suggestions (withdrawn) go; its name becomes
 * "Deleted user". What it
 * wrote stays, attributed to that anonymous name. The last administrator can't leave.
 * `checkedHash` is the password hash the password was checked against (null: none).
 */
export function deleteAccount(ctx: Context, userId: number, checkedHash: string | null): void {
  const { sql } = ctx;
  const user = requireUserRow(sql, userId);
  if (user.password_hash !== checkedHash) throw forbidden("The password is wrong.");
  if (user.role === "administrator" && administratorCount(sql) === 1) {
    throw badRequest("You are the only administrator. Make someone else an administrator first.");
  }
  withdrawPendingOf(ctx, userId);
  forgetVolunteerName(ctx, userId, DELETED_NAME);
  revokeInvitesBy(ctx, userId);
  sql.run("DELETE FROM identities WHERE user_id = ?", userId);
  sql.run("DELETE FROM sessions WHERE user_id = ?", userId);
  sql.run("DELETE FROM email_tokens WHERE user_id = ?", userId);
  sql.run(
    `UPDATE users SET email = NULL, password_hash = NULL, display_name = ?, avatar_url = NULL,
       role = 'none', languages = NULL, email_verified = 0, volunteer_status = NULL,
       volunteer_languages = NULL, volunteer_message = NULL, volunteer_requested_at = NULL,
       deleted_at = ?
     WHERE id = ?`,
    DELETED_NAME,
    ctx.clock(),
    userId,
  );
  ctx.logger.info("Account deleted", { userId });
}

export async function completeAccountDeletionAsync(
  sql: Sql,
  actor: Actor,
  checkedHash: string | null,
  now: number,
  logger: Logger = silentLogger,
): Promise<{ ok: true }> {
  const id = actor.type === "user" ? actor.userId : null;
  const result = await withRetries(
    sql,
    async () => {
      const [revision, users, administrators, pending, activity, ...permissionRows] =
        await sql.read([
          {
            sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
          },
          {
            sql: "SELECT role, password_hash FROM users WHERE id = ? AND deleted_at IS NULL",
            params: [id],
          },
          {
            sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'administrator' AND deleted_at IS NULL",
          },
          {
            sql: "SELECT id, string_id, language, value FROM suggestions WHERE author_type = 'user' AND author_id = ? AND status = 'pending'",
            params: [id],
          },
          {
            sql: "SELECT id, summary, detail FROM activity WHERE type = 'review' AND instr(detail, '\"volunteer\"') > 0",
          },
          ...permissionReadStatements(actor),
        ]);
      return {
        revision: Number(revision[0].revision),
        state: {
          user: users[0] as { role: Role; password_hash: string | null } | undefined,
          administrators: Number(administrators[0].n),
          pending: pending as WithdrawalRow[],
          activity: activity as { id: number; summary: string; detail: string }[],
          permissions: permissionsFromRows(actor, permissionRows),
        },
      };
    },
    ({ user, administrators, pending, activity, permissions }) => {
      permissions.require("account");
      const userId = userIdOf(actor);
      if (user === undefined) throw notFound(`User ${userId}`);
      if (user.password_hash !== checkedHash) throw forbidden("The password is wrong.");
      if (user.role === "administrator" && administrators <= 1)
        throw badRequest(
          "You are the only administrator. Make someone else an administrator first.",
        );
      return {
        statements: [
          ...pending.flatMap((row) =>
            planSuggestionWithdrawal(row, { type: "user", id: userId, label: null }, now),
          ),
          ...planForgetVolunteerName(activity, userId, DELETED_NAME),
          {
            sql: "UPDATE invites SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL",
            params: [now, userId],
          },
          { sql: "DELETE FROM identities WHERE user_id = ?", params: [userId] },
          { sql: "DELETE FROM sessions WHERE user_id = ?", params: [userId] },
          { sql: "DELETE FROM email_tokens WHERE user_id = ?", params: [userId] },
          {
            sql: "UPDATE users SET email = NULL, password_hash = NULL, display_name = ?, avatar_url = NULL, role = 'none', languages = NULL, email_verified = 0, volunteer_status = NULL, volunteer_languages = NULL, volunteer_message = NULL, volunteer_requested_at = NULL, deleted_at = ? WHERE id = ?",
            params: [DELETED_NAME, now, userId],
          },
        ],
        result: { ok: true as const },
      };
    },
  );
  logger.info("Account deleted", { userId: id });
  return result;
}

export async function deleteAccountAsync(
  sql: Sql,
  actor: Actor,
  request: DeleteAccountRequest,
  passwords: PasswordOptions | undefined,
  now: number,
  logger: Logger = silentLogger,
): Promise<{ ok: true }> {
  const id = actor.type === "user" ? actor.userId : null;
  const [users, ...permissionRows] = await sql.read([
    { sql: "SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL", params: [id] },
    ...permissionReadStatements(actor),
  ]);
  permissionsFromRows(actor, permissionRows).require("account");
  const userId = userIdOf(actor);
  if (users[0] === undefined) throw notFound(`User ${userId}`);
  const checkedHash = users[0].password_hash as string | null;
  if (checkedHash !== null) {
    if (passwords === undefined)
      throw new ServiceError("internal", "Password authentication is not configured.");
    if (request.password === undefined)
      throw badRequest("Enter your password to delete your account.");
    const checked = await verifyPassword(request.password, checkedHash, passwords);
    if (!checked.ok) throw forbidden("The password is wrong.");
  }
  return completeAccountDeletionAsync(sql, actor, checkedHash, now, logger);
}
