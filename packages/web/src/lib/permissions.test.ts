// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals } from "@std/assert";
import type { Role } from "@quaso/core";
import type { Context } from "../../../service/src/context.ts";
import { can as serviceCan } from "../../../service/src/permissions.ts";
import { type Action, ACTIONS, can } from "./permissions.ts";

/**
 * The table of design §5.8, one row per action: who may do it. As in the service,
 * administrators may do everything but volunteer, and managers may also suggest (to ask for
 * a second opinion); both edit directly, so the editor offers them Save rather than Suggest.
 */
const TABLE: Record<Action, (Role | "anyone")[]> = {
  read: ["anyone", "none", "contributor", "manager", "administrator"],
  download: ["administrator"],
  upload: ["administrator"],
  volunteer: ["none"],
  suggest: ["contributor", "manager", "administrator"],
  edit: ["manager", "administrator"],
  review: ["manager", "administrator"],
  translate: ["manager", "administrator"],
  usage: ["manager", "administrator"],
  team: ["administrator"],
  settings: ["administrator"],
  tokens: ["administrator"],
  backup: ["administrator"],
  glossary: ["manager", "administrator"],
  comment: ["contributor", "manager", "administrator"],
  issues: ["manager", "administrator"],
  requestLanguage: ["none", "contributor", "manager", "administrator"],
};

test("can() follows the design's permission table", () => {
  for (const action of ACTIONS) {
    assertEquals(can(null, action), TABLE[action].includes("anyone"), `anyone: ${action}`);
    for (const role of ["none", "contributor", "manager", "administrator"] as const) {
      assertEquals(
        can({ role, languages: null }, action),
        TABLE[action].includes(role),
        `${role}: ${action}`,
      );
    }
  }
});

test("language limits apply to suggesting, editing and reviewing", () => {
  const contributor = { role: "contributor" as const, languages: ["de", "pt-BR"] };
  assertEquals(can(contributor, "suggest", "de"), true);
  assertEquals(can(contributor, "suggest", "pt-br"), true);
  assertEquals(can(contributor, "suggest", "fr"), false);
  assertEquals(can(contributor, "suggest"), true);
  assertEquals(can(contributor, "read", "fr"), true);
  const manager = { role: "manager" as const, languages: ["fr"] };
  assertEquals(can(manager, "edit", "fr"), true);
  assertEquals(can(manager, "edit", "de"), false);
  assertEquals(can(manager, "review", "de"), false);
  // Running the LLM isn't limited by language (as in the service).
  assertEquals(can(manager, "translate", "de"), true);
});

test("as in the service: no language list limits administrators", () => {
  // A manager limited to German who was promoted keeps the list; it no longer applies.
  const administrator = { role: "administrator" as const, languages: ["de"] };
  for (const action of ["suggest", "edit", "review"] as const) {
    assertEquals(can(administrator, action, "fr"), true, action);
  }
});

test("as in the service: tags compare in their canonical form", () => {
  const contributor = { role: "contributor" as const, languages: ["iw", "zh-hans"] };
  assertEquals(can(contributor, "suggest", "he"), true);
  assertEquals(can(contributor, "suggest", "zh-Hans"), true);
  assertEquals(can(contributor, "suggest", "zh-Hant"), false);
  const manager = { role: "manager" as const, languages: ["he"] };
  assertEquals(can(manager, "edit", "iw"), true);
  assertEquals(can(manager, "edit", "ar"), false);
});

test("can() gives the service's answer for every role, language list, action and language", () => {
  const roles: Role[] = ["none", "contributor", "manager", "administrator"];
  const lists: (string[] | null)[] = [null, [], ["de"], ["iw", "pt-br"], ["DE", "zh-hans"]];
  const languages = [undefined, "de", "fr", "he", "pt-BR", "zh-Hans"];
  for (const role of roles) {
    for (const languagesOf of lists) {
      // The service reads the person's role and languages from its database.
      const ctx = {
        sql: {
          query: () => [
            {
              role,
              languages: languagesOf === null ? null : JSON.stringify(languagesOf),
            },
          ],
        },
      } as unknown as Context;
      for (const action of ACTIONS) {
        for (const language of languages) {
          assertEquals(
            can({ role, languages: languagesOf }, action, language),
            serviceCan(ctx, { type: "user", userId: 1 }, action, language),
            `${role} ${JSON.stringify(languagesOf)} ${action} ${language}`,
          );
        }
      }
    }
  }
});
