// SPDX-License-Identifier: MIT
/**
 * Helpers for the tests of accounts, the team and review: a service with fast password
 * hashing, people with roles, and a small project to translate.
 */
import type { ServiceOptions } from "../service.ts";
import type { Actor } from "../api.ts";
import { ANONYMOUS } from "../api.ts";
import { addUser, startTestService, type TestInstance, uploadJson } from "../test_helpers.ts";

/** Few iterations: the tests hash many passwords. `passwords.test.ts` covers the default. */
export const TEST_ITERATIONS = 1000;

export const PASSWORD = "correct horse battery";

/** A started service whose first administrator exists, so sign-up is open. */
export async function peopleService(
  options: Partial<ServiceOptions> = {},
): Promise<TestInstance & { admin: Actor }> {
  const instance = await startTestService({ passwordIterations: TEST_ITERATIONS, ...options });
  const admin = addUser(instance.sql, "administrator", null, "Admin");
  return Object.assign(instance, { admin });
}

/** Signs up a new person (role none) and returns their actor and session. */
export async function signUp(
  instance: TestInstance,
  email: string,
  displayName = email.split("@")[0],
  extra: { invite?: string; password?: string } = {},
) {
  const result = await instance.service.signUp(ANONYMOUS, {
    email,
    password: extra.password ?? PASSWORD,
    displayName,
    invite: extra.invite,
  });
  const actor: Actor = { type: "user", userId: result.user.id };
  return { ...result, actor };
}

/** English for review tests: text, a placeholder, a plural, and a limited one. */
export const ENGLISH = {
  play: "Play",
  greeting: "Hello, {{name}}!",
  items_one: "{{count}} item",
  items_other: "{{count}} items",
  quit: "Quit",
  save: "Save the game",
};

/** A people service with `common.json` (ENGLISH) in German and French. */
export async function projectService(options: Partial<ServiceOptions> = {}) {
  const instance = await peopleService(options);
  await uploadJson(
    instance.service,
    { "common.json": ENGLISH },
    {
      languages: ["de", "fr"],
      limits: [{ file: "common.json", key: "quit", maxLength: 8 }],
    },
  );
  return instance;
}
