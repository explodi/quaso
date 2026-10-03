// SPDX-License-Identifier: MIT
/**
 * Accounts in workerd (Sprint 6): password hashing (Web Crypto's PBKDF2, and the same
 * derivation in JavaScript for runtimes that cap the iterations), and the first start,
 * sign-up, sign-in, sessions and review through the data object over Workers RPC, on
 * Durable Object SQLite.
 */
import { ANONYMOUS, SYSTEM } from "@quaso/service";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ITERATIONS,
  hashPassword,
  parseHash,
  verifyPassword,
} from "../../service/src/passwords.ts";
import { unwrapCall } from "../src/data_object.ts";
import { env } from "./env.ts";

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

describe("accounts through the data object", () => {
  it("set up, sign up, sign in, suggest and review over RPC", async () => {
    const data = env.QUASO_DATA.get(env.QUASO_DATA.newUniqueId());
    type Json = any;
    const call = async (method: string, actor: unknown, input: unknown): Promise<Json> =>
      unwrapCall(await data.call(method, actor as never, input));

    const { token } = await call("ensureSetupToken", SYSTEM, {});
    expect(token).toMatch(/^[\w-]{43}$/);
    const owner = await call("completeSetup", ANONYMOUS, {
      token,
      email: "owner@example.com",
      password: PASSWORD,
      displayName: "Owner",
      projectName: "Quaso Quest",
    });
    expect(owner.user.role).toBe("administrator");
    const admin = { type: "user", userId: owner.user.id };
    expect(await call("resolveSession", SYSTEM, { sessionId: owner.sessionId })).toMatchObject({
      userId: owner.user.id,
    });

    await call("upload", SYSTEM, {
      files: [
        { path: "common.json", repoPath: "common.json", content: '{\n  "play": "Play"\n}\n' },
      ],
      languages: ["fr"],
    });
    const joined = await call("signUp", ANONYMOUS, {
      email: "camille@example.com",
      password: PASSWORD,
      displayName: "Camille",
    });
    const signedIn = await call("signIn", ANONYMOUS, {
      email: "Camille@example.com",
      password: PASSWORD,
    });
    expect(signedIn.user.id).toBe(joined.user.id);
    const wrong = await data.call("signIn", ANONYMOUS, {
      email: "camille@example.com",
      password: "x".repeat(10),
    });
    expect(wrong).toMatchObject({ ok: false, status: 401 });

    const volunteer = { type: "user", userId: joined.user.id };
    await call("requestVolunteer", volunteer, {
      languages: ["fr"],
      message: "Bonjour",
    });
    await call("reviewVolunteer", admin, {
      userId: joined.user.id,
      approve: true,
    });
    const strings = await call("listStrings", ANONYMOUS, { language: "fr" });
    const suggestion = await call("suggest", volunteer, {
      id: strings.strings[0].id,
      language: "fr",
      kind: "translation",
      value: "Jouer",
      baseRevision: 0,
    });
    const review = await call("reviewSuggestions", admin, {
      ids: [suggestion.id],
      action: "approve",
    });
    expect(review).toEqual({
      approved: [suggestion.id],
      rejected: [],
      failed: [],
    });
    const detail = await call("getString", ANONYMOUS, {
      id: strings.strings[0].id,
      language: "fr",
    });
    expect(detail.translation).toMatchObject({
      value: "Jouer",
      colour: "blue",
    });
    expect(detail.translation.author.name).toBe("Camille");
    expect(detail.translation.approver.name).toBe("Owner");

    await call("deleteAccount", volunteer, {
      confirm: "delete",
      password: PASSWORD,
    });
    const after = await call("getString", ANONYMOUS, {
      id: strings.strings[0].id,
      language: "fr",
    });
    expect(after.translation.author.name).toBe("Deleted user");
  });
});
