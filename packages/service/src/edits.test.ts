// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
import { ANONYMOUS } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { addUser, stringId, type TestInstance, uploadJson, write } from "./test_helpers.ts";
import { ENGLISH, projectService } from "./testing/people.ts";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((error: unknown) => error);
  assert(error instanceof ServiceError);
  expect(error.code, error.message).toStrictEqual(code);
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
  expect([translation.value, translation.colour, translation.outdated]).toStrictEqual([
    "Spielen",
    "blue",
    false,
  ]);
  expect([translation.author.name, translation.approver?.name]).toStrictEqual(["Morgan", "Morgan"]);

  const conflict = await rejectsWith(
    service.saveTranslation(manager, {
      ...target(instance, "play"),
      value: "Los",
      baseRevision: 0,
    }),
    "conflict",
  );
  expect(conflict.current?.value).toBe("Spielen");
  expect(conflict.current?.revision).toStrictEqual(translation.revision);
  const again = await service.saveTranslation(manager, {
    ...target(instance, "play"),
    value: "Los geht's",
    baseRevision: translation.revision,
  });
  expect(again.translation?.value).toBe("Los geht's");
  const history = await service.getHistory(ANONYMOUS, { ...target(instance, "play") });
  expect(history.entries.slice(0, 2).map((e) => [e.event, e.actor.name, e.after])).toStrictEqual([
    ["translation_saved", "Morgan", "Los geht's"],
    ["translation_saved", "Morgan", "Spielen"],
  ]);
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
  expect(error.details?.map((d) => [d.check, d.value, d.form])).toStrictEqual([
    ["placeholder_missing", "{{count}}", "other"],
  ]);
  expect((await instance.service.getString(ANONYMOUS, target(instance, "items"))).translation).toBe(
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
  expect([approved.translation?.colour, approved.translation?.value]).toStrictEqual([
    "blue",
    "Spielen",
  ]);
  expect([approved.translation?.author.name, approved.translation?.approver?.name]).toStrictEqual([
    "test-model",
    "Morgan",
  ]);

  // The English changes: the green translation is outdated until someone confirms it.
  const quit = write(instance, "common.json", "quit", "de", "Beenden");
  await uploadJson(service, { "common.json": { ...ENGLISH, quit: "Exit" } });
  const outdated = await service.getString(ANONYMOUS, target(instance, "quit"));
  expect(outdated.translation?.outdated).toBe(true);
  const confirmed = await service.approveTranslation(manager, {
    ...target(instance, "quit"),
    baseRevision: quit.revision,
  });
  expect([confirmed.translation?.colour, confirmed.translation?.outdated]).toStrictEqual([
    "blue",
    false,
  ]);
  const events = (await service.getHistory(ANONYMOUS, target(instance, "quit"))).entries;
  expect(events[0].event).toBe("translation_approved");
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
  expect([green.colour, green.value, green.approver]).toStrictEqual(["green", "Spielen", null]);
  // Unapproving a green one changes nothing.
  const same = await service.unapproveTranslation(manager, {
    ...target(instance, "play"),
    baseRevision: green.revision,
  });
  expect(same.translation?.revision).toStrictEqual(green.revision);
  await rejectsWith(
    service.deleteTranslation(manager, {
      ...target(instance, "play"),
      baseRevision: saved.revision,
    }),
    "conflict",
  );
  expect(
    await service.deleteTranslation(manager, {
      ...target(instance, "play"),
      baseRevision: green.revision,
    }),
  ).toStrictEqual({ translation: null });
  const events = (await service.getHistory(ANONYMOUS, target(instance, "play"))).entries;
  expect(events.slice(0, 3).map((e) => [e.event, e.beforeColour, e.afterColour])).toStrictEqual([
    ["translation_deleted", "green", null],
    ["translation_unapproved", "blue", "green"],
    ["translation_saved", null, "blue"],
  ]);
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
  expect((await service.saveTranslation(admin, input)).translation?.colour).toBe("blue");
  const limited = addUser(instance.sql, "manager", ["FR"]);
  expect(
    (
      await service.saveTranslation(limited, {
        ...target(instance, "quit", "fr"),
        value: "Quitter",
        baseRevision: 0,
      })
    ).translation?.value,
  ).toBe("Quitter");
});
