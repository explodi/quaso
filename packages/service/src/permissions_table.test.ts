// SPDX-License-Identifier: MIT
import { test } from "node:test";
/**
 * The whole permission table (design §5.8, ROLE-2, ROLE-3): every action, for every kind
 * of actor, with no language, a language the person is limited to, and another one, for
 * people limited to French and for people with every language. A new action fails here
 * until it has its row.
 */
import { assertEquals } from "@std/assert";
import { type Actor, ANONYMOUS, SYSTEM } from "./api.ts";
import { type Action, ACTIONS, can } from "./permissions.ts";
import { addUser, createToken, startTestService } from "./test_helpers.ts";

type Who =
  | "anonymous"
  | "none"
  | "contributor"
  | "manager"
  | "administrator"
  | "deleted"
  | "read key"
  | "upload key"
  | "system";

const PEOPLE = ["none", "contributor", "manager", "administrator"] as const;
const EVERYONE: Who[] = [
  "anonymous",
  "none",
  "contributor",
  "manager",
  "administrator",
  "read key",
  "upload key",
  "system",
];

/** Who may do each action (the system may do everything; deleted people only read). */
const TABLE: Record<Action, Who[]> = {
  // Browse languages, strings, translations and history: anyone.
  read: EVERYONE,
  download: ["read key", "upload key", "administrator", "system"],
  upload: ["upload key", "administrator", "system"],
  // Run the LLM: managers, administrators and upload keys.
  translate: ["manager", "administrator", "upload key", "system"],
  // See LLM usage.
  usage: ["manager", "administrator", "upload key", "system"],
  // Settings, API keys, backups, the team: administrators.
  tokens: ["administrator", "system"],
  settings: ["administrator", "system"],
  team: ["administrator", "system"],
  backup: ["administrator", "system"],
  // A file's context for the LLM: managers too.
  context: ["manager", "administrator", "system"],
  glossary: ["manager", "administrator", "system"],
  issues: ["manager", "administrator", "system"],
  comment: ["contributor", "manager", "administrator", "system"],
  requestLanguage: ["none", "contributor", "manager", "administrator", "system"],
  // Approve or reject pending changes; edit directly (blue).
  review: ["manager", "administrator", "system"],
  edit: ["manager", "administrator", "system"],
  // Send translations, corrections and "looks good": contributors and above.
  suggest: ["contributor", "manager", "administrator", "system"],
  // Ask to become a volunteer: signed in, without a role.
  volunteer: ["none", "system"],
  // One's own account: anyone signed in.
  account: ["none", "contributor", "manager", "administrator", "system"],
};

/** Actions limited to the person's languages (ROLE-3); never for administrators. */
const LIMITED: Action[] = ["suggest", "edit", "review", "glossary", "comment"];

test("permissions: the whole table, every action for every actor and language limit", async () => {
  using instance = await startTestService();
  const { ctx, sql, service } = instance;
  const actors: { who: Who; limited: boolean; actor: Actor }[] = [
    { who: "anonymous", limited: false, actor: ANONYMOUS },
    { who: "system", limited: false, actor: SYSTEM },
    { who: "read key", limited: false, actor: (await createToken(service, "read")).actor },
    { who: "upload key", limited: false, actor: (await createToken(service, "upload")).actor },
  ];
  for (const role of PEOPLE) {
    actors.push({ who: role, limited: false, actor: addUser(sql, role, null) });
    actors.push({ who: role, limited: true, actor: addUser(sql, role, ["fr"]) });
  }
  for (const limited of [false, true]) {
    const actor = addUser(sql, "administrator", limited ? ["fr"] : null, "Deleted");
    sql.run(
      "UPDATE users SET deleted_at = 1 WHERE id = ?",
      actor.type === "user" ? actor.userId : 0,
    );
    actors.push({ who: "deleted", limited, actor });
  }

  const problems: string[] = [];
  let checked = 0;
  for (const action of ACTIONS) {
    const row = TABLE[action];
    if (row === undefined) {
      problems.push(`${action}: missing from the permission table`);
      continue;
    }
    for (const { who, limited, actor } of actors) {
      for (const language of [undefined, "fr", "de"]) {
        let expected = who === "deleted" ? action === "read" : row.includes(who);
        if (
          expected &&
          limited &&
          language === "de" &&
          who !== "administrator" &&
          LIMITED.includes(action)
        ) {
          expected = false;
        }
        const actual = can(ctx, actor, action, language);
        checked++;
        if (actual !== expected) {
          problems.push(
            `${action} by ${who}${limited ? " (limited to fr)" : ""} in ${
              language ?? "no language"
            }: ` + `expected ${expected}, got ${actual}`,
          );
        }
      }
    }
  }
  assertEquals(problems, []);
  assertEquals(checked, ACTIONS.length * 14 * 3);
  assertEquals(Object.keys(TABLE).sort(), [...ACTIONS].sort(), "no rows for unknown actions");
});
