// SPDX-License-Identifier: MIT
import { ANONYMOUS, SYSTEM, type Actor } from "../api.ts";
import { ServiceError } from "../errors.ts";
import type { Sql } from "../ports.ts";
import { requestVolunteerAsync, reviewVolunteerAsync } from "../team.ts";
import { asyncWriteMethods } from "../write_methods.ts";
import { check, checkEqual } from "./assert.ts";

const USER: Actor = { type: "user", userId: 1 };
const ADMIN: Actor = { type: "user", userId: 2 };
const REQUEST = { languages: ["DE", "fr", "de"], message: " Hello " };

async function seed(sql: Sql) {
  await sql.commit(0, [
    {
      sql: "INSERT INTO users (id, email, display_name, role, created_at, deleted_at) VALUES (1, 'ada@example.com', 'Ada', 'none', 100, NULL), (2, 'admin@example.com', 'Admin', 'administrator', 100, NULL), (3, 'manager@example.com', 'Manager', 'manager', 100, NULL), (4, NULL, 'Deleted', 'none', 100, 150)",
    },
    { sql: "INSERT INTO languages (tag, created_at) VALUES ('de', 100), ('fr', 100)" },
    {
      sql: "INSERT INTO identities (user_id, provider, subject, username, created_at) VALUES (1, 'github', 'subject', 'octo', 100)",
    },
    {
      sql: "INSERT INTO history (string_id, language, event, actor_type, actor_id, created_at) VALUES (1, 'de', 'translation_saved', 'user', 1, 100), (1, 'de', 'suggestion_created', 'user', 1, 100)",
    },
  ]);
}

async function ask(sql: Sql) {
  await seed(sql);
  await requestVolunteerAsync(sql, USER, REQUEST, 200);
}

async function rejected(run: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof ServiceError);
  checkEqual(failure.code, code);
}

async function failed(run: () => Promise<unknown>) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof Error);
}

export const VOLUNTEER_WRITES_CASES: { name: string; run(sql: Sql): Promise<void> }[] = [
  {
    name: "requests canonicalize languages and trim messages while retaining account metadata",
    async run(sql) {
      await seed(sql);
      const result = await requestVolunteerAsync(sql, USER, REQUEST, 200);
      checkEqual(
        [result.displayName, result.role, result.identities, result.volunteerRequest],
        [
          "Ada",
          "none",
          [{ provider: "github", username: "octo" }],
          { status: "pending", languages: ["de", "fr"], message: "Hello", createdAt: 200 },
        ],
      );
      await rejected(() => requestVolunteerAsync(sql, USER, REQUEST, 300), "conflict");
      const [revision] = await sql.read([{ sql: "SELECT value FROM meta WHERE key = 'revision'" }]);
      checkEqual(revision[0].value, "2");
    },
  },
  {
    name: "request access requires an active person without a team role and current project languages",
    async run(sql) {
      await seed(sql);
      await rejected(() => requestVolunteerAsync(sql, ANONYMOUS, REQUEST, 200), "unauthorized");
      await rejected(() => requestVolunteerAsync(sql, ADMIN, REQUEST, 200), "forbidden");
      await rejected(
        () => requestVolunteerAsync(sql, { type: "user", userId: 3 }, REQUEST, 200),
        "forbidden",
      );
      await rejected(
        () => requestVolunteerAsync(sql, { type: "user", userId: 4 }, REQUEST, 200),
        "forbidden",
      );
      await rejected(() => requestVolunteerAsync(sql, SYSTEM, REQUEST, 200), "bad_request");
      await rejected(
        () => requestVolunteerAsync(sql, USER, { languages: ["es"], message: "" }, 200),
        "bad_request",
      );
    },
  },
  {
    name: "approval defaults to requested languages and records the administrator with current contributions",
    async run(sql) {
      await ask(sql);
      const result = await reviewVolunteerAsync(sql, ADMIN, 1, { approve: true }, 300);
      checkEqual(
        [result.role, result.languages, result.contributions, result.volunteerRequest],
        [
          "contributor",
          ["de", "fr"],
          1,
          { status: "approved", languages: ["de", "fr"], message: "Hello", createdAt: 200 },
        ],
      );
      const [activity] = await sql.read([
        {
          sql: "SELECT actor_type, actor_id, actor_label, summary, detail, created_at FROM activity",
        },
      ]);
      checkEqual(activity, [
        {
          actor_type: "user",
          actor_id: 2,
          actor_label: null,
          summary: "Volunteer approved: Ada, as contributor (de, fr)",
          detail:
            '{"kind":"volunteer","userId":1,"approved":true,"role":"contributor","languages":["de","fr"]}',
          created_at: 300,
        },
      ]);
      await rejected(
        () => reviewVolunteerAsync(sql, ADMIN, 1, { approve: true }, 400),
        "not_found",
      );
    },
  },
  {
    name: "rejection leaves no public activity and permits a new request with an explicit unrestricted grant",
    async run(sql) {
      await ask(sql);
      const rejectedMember = await reviewVolunteerAsync(
        sql,
        ADMIN,
        1,
        { approve: false, languages: ["es"] },
        300,
      );
      checkEqual(
        [rejectedMember.role, rejectedMember.volunteerRequest?.status],
        ["none", "rejected"],
      );
      const [activity] = await sql.read([{ sql: "SELECT id FROM activity" }]);
      checkEqual(activity, []);
      await requestVolunteerAsync(sql, USER, { languages: ["de"], message: "Again" }, 400);
      const approved = await reviewVolunteerAsync(
        sql,
        SYSTEM,
        1,
        { approve: true, role: "manager", languages: null },
        500,
      );
      checkEqual([approved.role, approved.languages], ["manager", null]);
      const [reviewer] = await sql.read([
        { sql: "SELECT actor_type, actor_id, actor_label FROM activity" },
      ]);
      checkEqual(reviewer, [{ actor_type: "system", actor_id: null, actor_label: "System" }]);
    },
  },
  {
    name: "review access and missing requests are rejected and explicit grants are canonicalized",
    async run(sql) {
      await ask(sql);
      await rejected(() => reviewVolunteerAsync(sql, USER, 1, { approve: true }, 300), "forbidden");
      await rejected(
        () => reviewVolunteerAsync(sql, { type: "user", userId: 3 }, 1, { approve: true }, 300),
        "forbidden",
      );
      await rejected(
        () => reviewVolunteerAsync(sql, ADMIN, 4, { approve: true }, 300),
        "not_found",
      );
      await rejected(
        () => reviewVolunteerAsync(sql, ADMIN, 2, { approve: true }, 300),
        "not_found",
      );
      await rejected(
        () => reviewVolunteerAsync(sql, ADMIN, 1, { approve: true, languages: ["es"] }, 300),
        "bad_request",
      );
      const result = await reviewVolunteerAsync(
        sql,
        ADMIN,
        1,
        { approve: true, languages: ["FR", "fr"] },
        300,
      );
      checkEqual(result.languages, ["fr"]);
    },
  },
  {
    name: "competing volunteer requests cannot replace the first request",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await requestVolunteerAsync(sql, USER, { languages: ["fr"], message: "Winner" }, 150);
          return rows;
        },
      };
      await rejected(() => requestVolunteerAsync(changing, USER, REQUEST, 200), "conflict");
      const [request] = await sql.read([
        { sql: "SELECT volunteer_message, volunteer_requested_at FROM users WHERE id = 1" },
      ]);
      checkEqual(
        [reads, request],
        [2, [{ volunteer_message: "Winner", volunteer_requested_at: 150 }]],
      );
    },
  },
  {
    name: "request retries recheck a concurrent team grant and a removed project language",
    async run(sql) {
      await seed(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(1, [{ sql: "DELETE FROM languages WHERE tag = 'fr'" }]);
          return rows;
        },
      };
      await rejected(() => requestVolunteerAsync(changing, USER, REQUEST, 200), "bad_request");
      let nextReads = 0;
      const granted: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++nextReads === 1)
            await sql.commit(2, [{ sql: "UPDATE users SET role = 'contributor' WHERE id = 1" }]);
          return rows;
        },
      };
      await rejected(
        () => requestVolunteerAsync(granted, USER, { languages: ["de"], message: "" }, 200),
        "forbidden",
      );
      checkEqual([reads, nextReads], [2, 2]);
    },
  },
  {
    name: "review conflicts refresh the volunteer name, requested languages and contribution count",
    async run(sql) {
      await ask(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(2, [
              {
                sql: "UPDATE users SET display_name = 'New name', volunteer_languages = '[\"fr\"]' WHERE id = 1",
              },
              {
                sql: "INSERT INTO history (string_id, language, event, actor_type, actor_id, created_at) VALUES (1, 'fr', 'translation_saved', 'user', 1, 250)",
              },
            ]);
          return rows;
        },
      };
      const result = await reviewVolunteerAsync(changing, ADMIN, 1, { approve: true }, 300);
      const [activity] = await sql.read([{ sql: "SELECT summary FROM activity" }]);
      checkEqual(
        [reads, result.displayName, result.languages, result.contributions, activity],
        [
          2,
          "New name",
          ["fr"],
          2,
          [{ summary: "Volunteer approved: New name, as contributor (fr)" }],
        ],
      );
    },
  },
  {
    name: "a removed default grant during a conflict prevents approval",
    async run(sql) {
      await ask(sql);
      let reads = 0;
      const changing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(2, [{ sql: "DELETE FROM languages WHERE tag = 'fr'" }]);
          return rows;
        },
      };
      await rejected(
        () => reviewVolunteerAsync(changing, ADMIN, 1, { approve: true }, 300),
        "bad_request",
      );
      const [user, activity] = await sql.read([
        { sql: "SELECT role, volunteer_status FROM users WHERE id = 1" },
        { sql: "SELECT id FROM activity" },
      ]);
      checkEqual([reads, user, activity], [2, [{ role: "none", volunteer_status: "pending" }], []]);
    },
  },
  {
    name: "administrator demotion and competing reviews prevent stale review commits",
    async run(sql) {
      await ask(sql);
      let reads = 0;
      const demoted: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++reads === 1)
            await sql.commit(2, [{ sql: "UPDATE users SET role = 'manager' WHERE id = 2" }]);
          return rows;
        },
      };
      await rejected(
        () => reviewVolunteerAsync(demoted, ADMIN, 1, { approve: true }, 300),
        "forbidden",
      );
      let nextReads = 0;
      const competing: Sql = {
        ...sql,
        async read(statements) {
          const rows = await sql.read(statements);
          if (++nextReads === 1)
            await reviewVolunteerAsync(sql, SYSTEM, 1, { approve: false }, 250);
          return rows;
        },
      };
      await rejected(
        () => reviewVolunteerAsync(competing, SYSTEM, 1, { approve: true }, 300),
        "not_found",
      );
      checkEqual([reads, nextReads], [2, 2]);
    },
  },
  {
    name: "failed request and approval roll back user and activity changes without success logs",
    async run(sql) {
      await seed(sql);
      const queries = [
        { sql: "SELECT * FROM users ORDER BY id" },
        { sql: "SELECT * FROM activity ORDER BY id" },
        { sql: "SELECT value FROM meta WHERE key = 'revision'" },
      ];
      const before = await sql.read(queries);
      const logs: unknown[] = [];
      const logger = {
        info: (message: string) => logs.push(message),
        debug() {},
        warn() {},
        error() {},
      };
      const failing: Sql = {
        ...sql,
        commit: (revision, statements) =>
          sql.commit(revision, [
            ...statements,
            { sql: "INSERT INTO missing_volunteer_table VALUES (1)" },
          ]),
      };
      await failed(() => requestVolunteerAsync(failing, USER, REQUEST, 200, logger));
      checkEqual(await sql.read(queries), before);
      await requestVolunteerAsync(sql, USER, REQUEST, 200);
      const pending = await sql.read(queries);
      await failed(() => reviewVolunteerAsync(failing, ADMIN, 1, { approve: true }, 300, logger));
      checkEqual(await sql.read(queries), pending);
      checkEqual(logs, []);
    },
  },
  {
    name: "validated volunteer entry points retain permission precedence and log no request messages",
    async run(sql) {
      await seed(sql);
      const logs: unknown[] = [];
      const api = asyncWriteMethods({
        sql,
        clock: () => 200,
        logger: {
          info: (message, data) => logs.push([message, data]),
          debug() {},
          warn() {},
          error() {},
        },
      });
      await rejected(
        () => api.requestVolunteer(USER, { languages: [], message: "" }),
        "validation_failed",
      );
      await rejected(
        () => api.requestVolunteer(ANONYMOUS, { languages: [], message: "" }),
        "unauthorized",
      );
      await rejected(
        () =>
          api.reviewVolunteer(ADMIN, {
            userId: 1,
            approve: true,
            role: "administrator" as "manager",
          }),
        "validation_failed",
      );
      await api.requestVolunteer(USER, { languages: ["DE", "fr"], message: "Private message" });
      await api.reviewVolunteer(ADMIN, { userId: 1, approve: false });
      checkEqual(logs, [
        ["Volunteer request", { userId: 1, languages: ["de", "fr"] }],
        ["Volunteer request declined", { userId: 1, by: 2 }],
      ]);
    },
  },
];
