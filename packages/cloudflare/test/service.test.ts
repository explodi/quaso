// SPDX-License-Identifier: MIT
/**
 * The service in workerd: the demo scenario against the fixture that local storage wrote,
 * and the data object over Workers RPC (errors, API keys, restarts, the alarm).
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type Actor, ANONYMOUS, DATABASE_VERSION, ServiceError, SYSTEM } from "@quaso/service";
import { describe, expect, it } from "vitest";
import { ALARM_KEY_PREFIX, AlarmScheduler } from "../src/alarm_scheduler.ts";
import { dataObject, settingsProblem, unwrapCall } from "../src/data_object.ts";
import { createDurableObjectSql } from "../src/do_sql.ts";
import { env, freshObject } from "./env.ts";
import fixture from "./fixtures/demo.json";
import { runScenario, type ScenarioInput } from "./scenario.ts";

const input = fixture.input as unknown as ScenarioInput;

/** A new data object: the real class, on its own storage. */
function freshData() {
  return env.QUASO_DATA.get(env.QUASO_DATA.newUniqueId());
}

describe("the demo scenario", () => {
  it("gives exactly what local storage gives: reads, the export and every table", async () => {
    const output = await runInDurableObject(freshObject(), (_object, state) =>
      runScenario(createDurableObjectSql(state.storage), input),
    );
    const expected = fixture.output as Record<string, unknown>;
    // The export first, for a readable failure: byte-identical files.
    const files = (
      output.export as {
        files: { path: string; language: string; content: string; sha256: string }[];
      }
    ).files;
    const want = (expected.export as typeof output.export as { files: typeof files }).files;
    expect(files.map((file) => `${file.language}/${file.path}`)).toEqual(
      want.map((file) => `${file.language}/${file.path}`),
    );
    for (let i = 0; i < files.length; i++) {
      expect(files[i].content, `${files[i].language}/${files[i].path}`).toBe(want[i].content);
      expect(files[i].sha256).toBe(want[i].sha256);
    }
    for (const key of Object.keys(expected)) {
      expect(output[key], key).toEqual(expected[key]);
    }
    expect(Object.keys(output).sort()).toEqual(Object.keys(expected).sort());
  });
});

describe("the data object over RPC", () => {
  it("starts the service, migrated, on a new object", async () => {
    const health = unwrapCall(await freshData().call("getHealth", SYSTEM, {}));
    expect(health).toEqual({
      ok: true,
      schemaVersion: DATABASE_VERSION,
      revision: 0,
      busy: false,
      nextWakeUp: null,
    });
  });

  it("uploads, exports and counts, with an API key", async () => {
    const data = freshData();
    const key = unwrapCall(
      await data.call("createApiToken", SYSTEM, { name: "CI", scope: "upload" }),
    ) as { id: number; secret: string; scope: string };
    expect(key.secret).toMatch(/^qso_/);
    const found = unwrapCall(await data.call("authenticateToken", SYSTEM, { secret: key.secret }));
    expect(found).toEqual({ tokenId: key.id, scope: "upload", name: "CI" });

    const actor: Actor = { type: "token", tokenId: key.id };
    const upload = unwrapCall(await data.call("upload", actor, input.upload)) as {
      added: unknown[];
      revision: number;
    };
    expect(upload.added.length).toBeGreaterThan(0);
    const exported = unwrapCall(await data.call("exportFiles", actor, { languages: ["pl"] })) as {
      files: { language: string }[];
    };
    expect(exported.files.length).toBe(input.upload.files.length);
    expect(new Set(exported.files.map((file) => file.language))).toEqual(new Set(["pl"]));
    const status = unwrapCall(await data.call("getStatus", actor, {})) as {
      languages: { tag: string; untranslated: number }[];
    };
    expect(status.languages.map((language) => language.tag).sort()).toEqual(
      [...(input.upload.languages ?? [])].sort(),
    );

    // Revoked keys stop working.
    unwrapCall(await data.call("revokeApiToken", SYSTEM, { id: key.id }));
    expect(
      unwrapCall(await data.call("authenticateToken", SYSTEM, { secret: key.secret })),
    ).toBeNull();
    const listed = unwrapCall(await data.call("listApiTokens", SYSTEM, {})) as {
      tokens: { id: number; revokedAt: unknown }[];
    };
    expect(listed.tokens.map((token) => token.id)).toEqual([key.id]);
  });

  it("carries errors across RPC as { ok: false, status, body }", async () => {
    const data = freshData();
    const refused = await data.call("upload", ANONYMOUS, { files: [] });
    expect(refused).toEqual({
      ok: false,
      status: 401,
      body: { error: { code: "unauthorized", message: "Sign in, or send an API key." } },
    });
    const error = (() => {
      try {
        unwrapCall(refused);
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(401);

    const invalid = await data.call("listFiles", ANONYMOUS, { language: "not a tag!" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("validation_failed");
      expect(invalid.body.error.details?.[0].path).toBe("language");
    }
    const missing = await data.call("getString", ANONYMOUS, { id: 999, language: "pl" });
    expect(missing.ok ? 200 : missing.status).toBe(404);
    for (const name of ["nope", "constructor", "start", "alarm", "call"]) {
      const unknown = await data.call(name, SYSTEM, {});
      expect(unknown.ok ? 200 : unknown.status, name).toBe(404);
    }
  });

  it("searches with the longest query the API takes, in any script", async () => {
    // Durable Objects refuse LIKE patterns over 50 bytes; 200 CJK characters are 600.
    const data = freshData();
    const story = "你好，旅行者。".repeat(40);
    const content = JSON.stringify({ intro: story, save: "C:\\Games\\save_1" });
    unwrapCall(
      await data.call("upload", SYSTEM, {
        files: [{ path: "story.json", repoPath: "story.json", content }],
        sourceLanguage: "en",
        languages: ["pl"],
      }),
    );
    const search = async (q: string) => {
      const page = unwrapCall(await data.call("listStrings", ANONYMOUS, { language: "pl", q })) as {
        strings: { key: string }[];
      };
      return page.strings.map((string) => string.key);
    };
    expect(await search(story.slice(3, 203))).toEqual(["intro"]);
    expect(await search("x".repeat(200))).toEqual([]);
    expect(await search("c:\\games\\save_1")).toEqual(["save"]);
    expect(await search("%")).toEqual([]);
  });

  it("keeps the data across restarts, and arms the stored wake-up again", async () => {
    const data = freshData();
    unwrapCall(await data.call("upload", SYSTEM, input.upload));
    const before = unwrapCall(await data.call("getHealth", SYSTEM, {})) as { revision: number };
    const wakeUp = Date.now() + 3_600_000;
    await runInDurableObject(data, (_object, state) => {
      createDurableObjectSql(state.storage).run(
        "INSERT INTO meta (key, value) VALUES ('next_alarm', ?)",
        String(wakeUp),
      );
    });
    await evictDurableObject(data);
    const after = unwrapCall(await data.call("getHealth", SYSTEM, {})) as { revision: number };
    expect(after.revision).toBe(before.revision);
    await runInDurableObject(data, async (_object, state) => {
      // The nightly backup has the alarm too: it is set to the earlier of the two.
      const pending = new AlarmScheduler(state.storage).pending();
      expect(pending).toEqual({ service: wakeUp, backup: expect.any(Number) });
      expect(await state.storage.getAlarm()).toBe(Math.min(wakeUp, pending.backup!));
    });
  });

  it("runs the service's due wake-up when the alarm fires, then clears it", async () => {
    const data = freshData();
    unwrapCall(await data.call("getHealth", SYSTEM, {}));
    // The service's wake-up is due, and the alarm is set for the backup, later: running
    // the alarm now must do the service's work, then leave the backup's time.
    const due = Date.now() - 1000;
    const backup = Date.now() + 86_400_000;
    await runInDurableObject(data, async (_object, state) => {
      createDurableObjectSql(state.storage).run(
        "INSERT INTO meta (key, value) VALUES ('next_alarm', ?)",
        String(due),
      );
      state.storage.kv.put(`${ALARM_KEY_PREFIX}service`, due);
      state.storage.kv.put(`${ALARM_KEY_PREFIX}backup`, backup);
      await state.storage.setAlarm(backup);
    });
    expect(await runDurableObjectAlarm(data)).toBe(true);
    await runInDurableObject(data, async (_object, state) => {
      const meta = createDurableObjectSql(state.storage).query(
        "SELECT value FROM meta WHERE key = 'next_alarm'",
      );
      expect(meta).toEqual([]);
      expect(new AlarmScheduler(state.storage).pending()).toEqual({ backup });
      expect(await state.storage.getAlarm()).toBe(backup);
    });
  });

  it("is created with the location hint, as one object named main", async () => {
    const stub = dataObject(env);
    expect(stub.id.equals(env.QUASO_DATA.idFromName("main"))).toBe(true);
    expect(unwrapCall(await stub.call("getHealth", SYSTEM, {}))).toMatchObject({ ok: true });
  });

  it("refuses to start without a good SECRET_KEY", () => {
    expect(settingsProblem({ SECRET_KEY: "" })).toMatch(/SECRET_KEY isn't set/);
    expect(settingsProblem({ SECRET_KEY: "short" })).toMatch(/at least 32 characters/);
    expect(settingsProblem({ SECRET_KEY: "x".repeat(32) })).toBeNull();
  });
});
