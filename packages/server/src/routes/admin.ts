// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
/**
 * The administrators' routes (S8.4, S8.5, S8.9, S9.2, S9.10, S10.1): settings, languages,
 * files, strings and renames; the admin page; backup downloads; and the restore at setup,
 * which lets an operator move an instance to another setup without a shell on it.
 */
import {
  AddLanguageRequest,
  ManagedSecretName,
  SetSecretRequest,
  TestEmailRequest,
  type AdminInfo,
  Id,
  LanguageTag,
  PublicationTime,
  RenameRequest,
  s,
  UpdateFileRequest,
  UpdateLanguageRequest,
  UpdateSettingsRequest,
  UpdateStringRequest,
} from "@quaso/core";
import { type Logger, ServiceError, SYSTEM, type Store } from "@quaso/service";
import { MB } from "../http/request.ts";
import type { RecentError } from "../log.ts";
import {
  jsonBackupResponse,
  restoreFile,
  saveBody,
  SQLITE_TYPE,
  sqliteBackupResponse,
  storedBackupSnapshot,
} from "../storage/backup_files.ts";
import type { ApiRoute } from "./api.ts";
import { route } from "./route.ts";
import { setupKeyConfigured } from "../setup_key.ts";
import { RATE_RULES } from "../rate_limit.ts";

/** What the routes here need from the server besides the service. */
export interface RouteHost {
  version: string;
  setup: "local" | "cloudflare";
  log: Logger;
  /** The server's recent errors, for the admin page. */
  recentErrors(): RecentError[];
  /** Local storage: a consistent copy of the database at a path (SQLite's backup API). */
  snapshotTo?: (path: string) => Promise<void>;
  /** Where temporary backup files go (the data folder with local storage). */
  tempDir?: string;
  store?: Store;
}

/** The header that carries the setup key to `POST /restore`. */
export const SETUP_KEY_HEADER = "X-Setup-Key";

/** The largest backup `POST /restore` takes. */
export const RESTORE_MAX_BYTES = 1024 * MB;

const TagParams = s.object({ tag: LanguageTag });
const IdParams = s.object({ id: Id });
const BackupQuery = s.object({
  format: s.enum(["sqlite", "json"]).optional().describe("sqlite (the default) or json"),
  at: PublicationTime.optional().describe(
    "Local storage: the newest retained backup at or before this UTC time",
  ),
  file: s
    .string({ minLength: 1, maxLength: 512 })
    .optional()
    .describe("Local storage: a scheduled or pre-migration SQLite backup key"),
});

/** The services a restore is running on: one at a time each. */
const restoring = new WeakSet<object>();

export const ADMIN_ROUTES: ApiRoute[] = [
  route({
    method: "POST",
    path: "/settings/email/test",
    operationId: "testEmail",
    summary: "Send a test message using saved email settings",
    tag: "Settings",
    access: "administrator",
    body: TestEmailRequest,
    handle: ({ service, actor, body, http }) => {
      http.accounts.limitEmail(http.ip, body.to);
      return service.testEmail(actor, body);
    },
  }),
  route({
    method: "POST",
    path: "/settings/llm/test",
    operationId: "testLlm",
    summary: "Test the stored Gemini key with a fresh model request",
    tag: "Settings",
    access: "administrator",
    body: s.object({}),
    handle: ({ service, actor }) => service.testLlm(actor, {}),
  }),
  route({
    method: "GET",
    path: "/settings/secrets",
    operationId: "listSecrets",
    summary: "Configured credential status; values are never returned",
    tag: "Settings",
    access: "administrator",
    handle: ({ service, actor }) => service.listSecrets(actor, {}),
  }),
  route({
    method: "PUT",
    path: "/settings/secrets/:name",
    operationId: "setSecret",
    summary: "Set or replace a credential",
    tag: "Settings",
    access: "administrator",
    params: s.object({ name: ManagedSecretName }),
    body: SetSecretRequest,
    handle: ({ service, actor, params, body }) =>
      service.setSecret(actor, { ...body, name: params.name }),
  }),
  route({
    method: "DELETE",
    path: "/settings/secrets/:name",
    operationId: "removeSecret",
    summary: "Remove a configured credential",
    tag: "Settings",
    access: "administrator",
    params: s.object({ name: ManagedSecretName }),
    handle: ({ service, actor, params }) => service.removeSecret(actor, { name: params.name }),
  }),
  route({
    method: "GET",
    path: "/settings",
    operationId: "getSettings",
    summary: "The settings, languages, files and models, for the Settings page",
    tag: "Settings",
    access: "administrator",
    handle: ({ service, actor }) => service.getSettings(actor, {}),
  }),
  route({
    method: "PATCH",
    path: "/settings",
    operationId: "updateSettings",
    summary: "Change settings: any top-level field; llm and llm.context merge",
    tag: "Settings",
    access: "administrator",
    body: UpdateSettingsRequest,
    handle: ({ service, actor, body }) => service.updateSettings(actor, body),
  }),
  route({
    method: "POST",
    path: "/languages",
    operationId: "addLanguage",
    summary: "Add a language (its old translations come back, if it had some)",
    tag: "Settings",
    access: "administrator",
    body: AddLanguageRequest,
    status: 201,
    handle: ({ service, actor, body }) => service.addLanguage(actor, body),
  }),
  route({
    method: "PATCH",
    path: "/languages/:tag",
    operationId: "updateLanguage",
    summary: "A language's LLM instructions and plural override",
    tag: "Settings",
    access: "administrator",
    params: TagParams,
    body: UpdateLanguageRequest,
    handle: ({ service, actor, params, body }) =>
      service.updateLanguage(actor, { ...body, tag: params.tag }),
  }),
  route({
    method: "DELETE",
    path: "/languages/:tag",
    operationId: "removeLanguage",
    summary: "Remove a language; its translations and history stay in the database",
    tag: "Settings",
    access: "administrator",
    params: TagParams,
    handle: ({ service, actor, params }) => service.removeLanguage(actor, { tag: params.tag }),
  }),
  route({
    method: "PATCH",
    path: "/files/:id",
    operationId: "updateFile",
    summary: "A file's context for the LLM",
    tag: "Settings",
    access: "manager",
    params: IdParams,
    body: UpdateFileRequest,
    handle: ({ service, actor, params, body }) =>
      service.updateFile(actor, { ...body, id: params.id }),
  }),
  route({
    method: "PATCH",
    path: "/strings/:id",
    operationId: "updateString",
    summary: "A string's description and length limit (not one set by the CLI config)",
    tag: "Strings",
    access: "administrator",
    params: IdParams,
    body: UpdateStringRequest,
    handle: ({ service, actor, params, body }) =>
      service.updateString(actor, { ...body, id: params.id }),
  }),
  route({
    method: "POST",
    path: "/renames",
    operationId: "renameKey",
    summary: "Move a removed key's translations and history to a new key (STR-6)",
    tag: "Strings",
    access: "administrator",
    body: RenameRequest,
    handle: ({ service, actor, body }) => service.renameKey(actor, body),
  }),
  route({
    method: "GET",
    path: "/admin",
    operationId: "getAdminInfo",
    summary: "The admin page: version, setup, database, recent errors, jobs, LLM, last backup",
    tag: "Administration",
    access: "administrator",
    handle: async ({ service, actor, host }): Promise<AdminInfo> => {
      const info = await service.getAdminInfo(actor, {});
      return {
        ...info,
        version: host.version,
        setup: host.setup,
        // The service's own (a restore that didn't finish) first, then the log's, newest first.
        recentErrors: [...info.recentErrors, ...host.recentErrors().slice(-20).reverse()],
      };
    },
  }),
  route({
    method: "GET",
    path: "/backup",
    operationId: "downloadBackup",
    summary: "Download the whole instance: one SQLite file, or JSON",
    tag: "Administration",
    access: "administrator",
    query: BackupQuery,
    produces: [SQLITE_TYPE, "application/json"],
    handle: async ({ service, actor, query, host }) => {
      const options = {
        snapshotTo: host.snapshotTo,
        tempDir: host.tempDir,
        onCleanupError: (error: unknown) =>
          host.log.warn("A backup's temporary file stayed", { error }),
      };
      if (query.at !== undefined || query.file !== undefined) {
        await service.backupInfo(actor, {});
        if (host.store === undefined)
          throw new ServiceError(
            "bad_request",
            "Retained SQLite backups are available with local storage.",
          );
        Object.assign(options, await storedBackupSnapshot(host.store, query));
      }
      return query.format === "json"
        ? jsonBackupResponse(service, actor, options)
        : sqliteBackupResponse(service, actor, options);
    },
  }),
  route({
    method: "POST",
    path: "/restore",
    operationId: "restoreBackup",
    summary: `Restore a backup file (SQLite, JSON or gzip JSON, as the body) into this new instance, before setup, with the setup key in ${SETUP_KEY_HEADER}`,
    tag: "Administration",
    access: "setup",
    consumes: [SQLITE_TYPE, "application/json", "application/gzip"],
    handle: async ({ service, request, host, http }) => {
      if (!setupKeyConfigured(http.accounts.config))
        throw new ServiceError(
          "unavailable",
          "Set SETUP_KEY to at least 16 random characters, then restart.",
        );
      http.accounts.limiter.check([`setup:${http.ip ?? "unknown"}`, RATE_RULES.setup]);
      const token = request.headers.get(SETUP_KEY_HEADER)?.trim() ?? "";
      if (token === "") {
        throw new ServiceError(
          "unauthorized",
          `Send the configured setup key in the ${SETUP_KEY_HEADER} header.`,
        );
      }
      const valid =
        (await service.validateSetupToken(SYSTEM, { token })).ok ||
        (await service.checkRestoreToken(SYSTEM, { token })).ok;
      if (!valid) {
        throw new ServiceError(
          "forbidden",
          "The setup key is wrong, or this instance is set up already: a backup only restores into a new instance.",
        );
      }
      if (restoring.has(service)) {
        throw new ServiceError("conflict", "A restore is running already.");
      }
      restoring.add(service);
      let path: string | null = null;
      try {
        path = await saveBody(request.body, RESTORE_MAX_BYTES, host.tempDir);
        host.log.warn("Restoring a backup", { setup: host.setup });
        const result = await restoreFile(service, path, { tempDir: host.tempDir });
        host.log.warn("Restored a backup", { ...result });
        return result;
      } finally {
        restoring.delete(service);
        if (path !== null) await fs.rm(path).catch(() => {});
      }
    },
  }),
];
