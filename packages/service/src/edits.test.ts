// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assertEquals, assertRejects } from "@quaso/runtime/assert";
import { ANONYMOUS } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, stringId, type TestInstance, uploadJson, write } from "./test_helpers.ts";
import { ENGLISH, projectService } from "./testing/people.ts";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await assertRejects(() => promise, ServiceError);
  assertEquals(error.code, code, error.message);
  return error;
}

function target(instance: TestInstance, key: string, language = "de") {
  return { id: stringId(instance.sql, "common.json", key), language };
}

test("edits: a manager's save is blue and approved by them; stale saves conflict", async () => {
  using instance = await projectService();
  const { service } = instance;
  const manager = addUser(instance.sql, "manager", null, "Morgan");
  const saved = await service.saveTranslation(manager, {
    ...target(instance, "play"),
    value: "Spielen",
    baseRevision: 0,
  });
  const translation = saved.translation!;
  assertEquals(
    [translation.value, translation.colour, translation.outdated],
    ["Spielen", "blue", false],
  );
  assertEquals([translation.author.name, translation.approver?.name], ["Morgan", "Morgan"]);

  const conflict = await rejectsWith(
    service.saveTranslation(manager, {
      ...target(instance, "play"),
      value: "Los",
      baseRevision: 0,
    }),
    "conflict",
  );
  assertEquals(conflict.current?.value, "Spielen");
  assertEquals(conflict.current?.revision, translation.revision);
  const again = await service.saveTranslation(manager, {
    ...target(instance, "play"),
    value: "Los geht's",
    baseRevision: translation.revision,
  });
  assertEquals(again.translation?.value, "Los geht's");
  const history = await service.getHistory(ANONYMOUS, { ...target(instance, "play") });
  assertEquals(
    history.entries.slice(0, 2).map((e) => [e.event, e.actor.name, e.after]),
    [
      ["translation_saved", "Morgan", "Los geht's"],
      ["translation_saved", "Morgan", "Spielen"],
    ],
  );
});

test("edits: a save that drops a placeholder is refused (acceptance test 9, person path)", async () => {
  using instance = await projectService();
  const manager = addUser(instance.sql, "manager");
  const error = await rejectsWith(
    instance.service.saveTranslation(manager, {
      ...target(instance, "items"),
      value: { one: "ein Gegenstand", other: "Gegenstände" },
      baseRevision: 0,
    }),
    "qa_failed",
  );
  assertEquals(
    error.details?.map((d) => [d.check, d.value, d.form]),
    [["placeholder_missing", "{{count}}", "other"]],
  );
  assertEquals(
    (await instance.service.getString(ANONYMOUS, target(instance, "items"))).translation,
    null,
  );
});

test("edits: approve a green one as it is; an outdated one becomes current", async () => {
  using instance = await projectService();
  const { service } = instance;
  const manager = addUser(instance.sql, "manager", null, "Morgan");
  const green = write(instance, "common.json", "play", "de", "Spielen");
  await rejectsWith(
    service.approveTranslation(manager, { ...target(instance, "save"), baseRevision: 0 }),
    "bad_request",
  );
  const approved = await service.approveTranslation(manager, {
    ...target(instance, "play"),
    baseRevision: green.revision,
  });
  assertEquals([approved.translation?.colour, approved.translation?.value], ["blue", "Spielen"]);
  assertEquals(
    [approved.translation?.author.name, approved.translation?.approver?.name],
    ["test-model", "Morgan"],
  );

  // The English changes: the green translation is outdated until someone confirms it.
  const quit = write(instance, "common.json", "quit", "de", "Beenden");
  await uploadJson(service, { "common.json": { ...ENGLISH, quit: "Exit" } });
  const outdated = await service.getString(ANONYMOUS, target(instance, "quit"));
  assertEquals(outdated.translation?.outdated, true);
  const confirmed = await service.approveTranslation(manager, {
    ...target(instance, "quit"),
    baseRevision: quit.revision,
  });
  assertEquals([confirmed.translation?.colour, confirmed.translation?.outdated], ["blue", false]);
  const events = (await service.getHistory(ANONYMOUS, target(instance, "quit"))).entries;
  assertEquals(events[0].event, "translation_approved");
});

test("edits: approving runs the checks against the current English", async () => {
  using instance = await projectService();
  const manager = addUser(instance.sql, "manager");
  const green = write(instance, "common.json", "quit", "de", "Beenden");
  await uploadJson(instance.service, { "common.json": { ...ENGLISH, quit: "Quit {{game}}" } });
  await rejectsWith(
    instance.service.approveTranslation(manager, {
      ...target(instance, "quit"),
      baseRevision: green.revision,
    }),
    "qa_failed",
  );
});

test("edits: unapprove makes blue green; delete makes it red", async () => {
  using instance = await projectService();
  const { service } = instance;
  const manager = addUser(instance.sql, "manager", null, "Morgan");
  const saved = (
    await service.saveTranslation(manager, {
      ...target(instance, "play"),
      value: "Spielen",
      baseRevision: 0,
    })
  ).translation!;
  const green = (
    await service.unapproveTranslation(manager, {
      ...target(instance, "play"),
      baseRevision: saved.revision,
    })
  ).translation!;
  assertEquals([green.colour, green.value, green.approver], ["green", "Spielen", null]);
  // Unapproving a green one changes nothing.
  const same = await service.unapproveTranslation(manager, {
    ...target(instance, "play"),
    baseRevision: green.revision,
  });
  assertEquals(same.translation?.revision, green.revision);
  await rejectsWith(
    service.deleteTranslation(manager, {
      ...target(instance, "play"),
      baseRevision: saved.revision,
    }),
    "conflict",
  );
  assertEquals(
    await service.deleteTranslation(manager, {
      ...target(instance, "play"),
      baseRevision: green.revision,
    }),
    { translation: null },
  );
  const events = (await service.getHistory(ANONYMOUS, target(instance, "play"))).entries;
  assertEquals(
    events.slice(0, 3).map((e) => [e.event, e.beforeColour, e.afterColour]),
    [
      ["translation_deleted", "green", null],
      ["translation_unapproved", "blue", "green"],
      ["translation_saved", null, "blue"],
    ],
  );
});

test("edits: only managers and administrators, in their languages", async () => {
  using instance = await projectService();
  const { service, admin } = instance;
  const input = { ...target(instance, "play", "fr"), value: "Jouer", baseRevision: 0 };
  await rejectsWith(service.saveTranslation(ANONYMOUS, input), "unauthorized");
  await rejectsWith(
    service.saveTranslation(addUser(instance.sql, "contributor"), input),
    "forbidden",
  );
  await rejectsWith(
    service.saveTranslation(addUser(instance.sql, "manager", ["de"]), input),
    "forbidden",
  );
  await rejectsWith(
    service.deleteTranslation(addUser(instance.sql, "manager", ["de"]), {
      ...target(instance, "play", "fr"),
      baseRevision: 0,
    }),
    "forbidden",
  );
  assertEquals((await service.saveTranslation(admin, input)).translation?.colour, "blue");
  const limited = addUser(instance.sql, "manager", ["FR"]);
  assertEquals(
    (
      await service.saveTranslation(limited, {
        ...target(instance, "quit", "fr"),
        value: "Quitter",
        baseRevision: 0,
      })
    ).translation?.value,
    "Quitter",
  );
});
