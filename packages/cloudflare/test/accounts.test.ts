// SPDX-License-Identifier: MIT
/** Account setup, passwords and review on the deployed D1 service. */
import { ANONYMOUS, SYSTEM, createAsyncService } from "@quaso/service";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ITERATIONS,
  hashPassword,
  parseHash,
  verifyPassword,
} from "../../service/src/passwords.ts";
import { sql } from "./env.ts";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";

const PASSWORD = "correct horse battery";

describe("passwords in workerd", () => {
  it("verify alike with Web Crypto and with the JavaScript derivation", async () => {
    const options = { secretKey: "k".repeat(32), iterations: 2000 };
    const hash = await hashPassword(PASSWORD, options);
    expect(
      (
        await verifyPassword(PASSWORD, hash, {
          ...options,
          forceFallback: true,
        })
      ).ok,
    ).toBe(true);
    const fallback = await hashPassword(PASSWORD, {
      ...options,
      forceFallback: true,
    });
    expect((await verifyPassword(PASSWORD, fallback, options)).ok).toBe(true);
    expect((await verifyPassword("wrong password", fallback, options)).ok).toBe(false);
  });

  it("hash with the default iteration count", async () => {
    const hash = await hashPassword(PASSWORD, {});
    expect(parseHash(hash)?.iterations).toBe(DEFAULT_ITERATIONS);
    expect((await verifyPassword(PASSWORD, hash, {})).ok).toBe(true);
  });
});

describe("accounts on D1", () => {
  beforeEach(() => resetUploadSql(sql));
  it("set up, sign up, sign in, suggest and review over RPC", async () => {
    const service = createAsyncService({
      sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "accounts-test",
    });
    await service.start();

    const { token } = await service.ensureSetupToken(SYSTEM, {});
    expect(token).toMatch(/^[\w-]{43}$/);
    const owner = await service.completeSetup(ANONYMOUS, {
      token: token!,
      email: "owner@example.com",
      password: PASSWORD,
      displayName: "Owner",
      projectName: "Quaso Quest",
    });
    expect(owner.user.role).toBe("administrator");
    const admin = { type: "user" as const, userId: owner.user.id };
    expect(await service.resolveSession(SYSTEM, { sessionId: owner.sessionId })).toMatchObject({
      userId: owner.user.id,
    });

    await service.upload(SYSTEM, {
      files: [
        { path: "common.json", repoPath: "common.json", content: '{\n  "play": "Play"\n}\n' },
      ],
      languages: ["fr"],
    });
    const joined = await service.signUp(ANONYMOUS, {
      email: "camille@example.com",
      password: PASSWORD,
      displayName: "Camille",
    });
    const signedIn = await service.signIn(ANONYMOUS, {
      email: "Camille@example.com",
      password: PASSWORD,
    });
    expect(signedIn.user.id).toBe(joined.user.id);
    await expect(
      service.signIn(ANONYMOUS, {
        email: "camille@example.com",
        password: "x".repeat(10),
      }),
    ).rejects.toMatchObject({ status: 401 });

    const volunteer = { type: "user" as const, userId: joined.user.id };
    await service.requestVolunteer(volunteer, {
      languages: ["fr"],
      message: "Bonjour",
    });
    await service.reviewVolunteer(admin, {
      userId: joined.user.id,
      approve: true,
    });
    const strings = await service.listStrings(ANONYMOUS, { language: "fr" });
    const suggestion = await service.suggest(volunteer, {
      id: strings.strings[0].id,
      language: "fr",
      kind: "translation",
      value: "Jouer",
      baseRevision: 0,
    });
    const review = await service.reviewSuggestions(admin, {
      ids: [suggestion.id],
      action: "approve",
    });
    expect(review).toEqual({
      approved: [suggestion.id],
      rejected: [],
      failed: [],
    });
    const detail = await service.getString(ANONYMOUS, {
      id: strings.strings[0].id,
      language: "fr",
    });
    expect(detail.translation).toMatchObject({
      value: "Jouer",
      colour: "blue",
    });
    expect(detail.translation?.author.name).toBe("Camille");
    expect(detail.translation?.approver?.name).toBe("Owner");

    await service.deleteAccount(volunteer, {
      confirm: "delete",
      password: PASSWORD,
    });
    const after = await service.getString(ANONYMOUS, {
      id: strings.strings[0].id,
      language: "fr",
    });
    expect(after.translation?.author.name).toBe("Deleted user");
  });
});
