// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { IntlMessageFormat } from "intl-messageformat";
import { createTranslator } from "../src/translator.js";

const french = {
  common: { greeting: "Bonjour, {name} !", apostrophe: "Le goûter n'attend pas !" },
  game: {
    count: "{count, plural, one {# noisette} other {# noisettes}}",
    butter:
      "{count, plural, =0 {Pas de beurre !} one {# noisette dans la poche.} other {# noisettes dans la poche.}}",
    report:
      "{gender, select, female {La maire a rapporté {count, plural, one {# noisette} other {# noisettes}}.} male {Le maire a rapporté {count, plural, one {# noisette} other {# noisettes}}.} other {À la mairie, Quaso a rapporté {count, plural, one {# noisette} other {# noisettes}}.}}",
    meows: ["Miaou !", "'{name}' est un exemple."],
  },
};
const spanish = {
  game: {
    report:
      "{gender, select, female {La alcaldesa ha traído {count, plural, one {# porción} other {# porciones}}.} male {El alcalde ha traído {count, plural, one {# porción} other {# porciones}}.} other {La persona en la alcaldía ha traído {count, plural, one {# porción} other {# porciones}}.}}",
  },
};

test("unfinished catalogs fall back per key, including blank translations", () => {
  const english = createTranslator({ fr: french, en: { common: { greeting: "" } } }, "en");
  const german = createTranslator({ fr: french, de: {} }, "de");

  assert.equal(english.t("greeting", { name: "Quaso" }), "Bonjour, Quaso !");
  assert.equal(german.t("apostrophe"), "Le goûter n'attend pas !");
  assert.equal(english.t("missing"), "missing");
});

test("the message inspector shows the exact pattern and locale used by the formatter", () => {
  const i18n = createTranslator({ fr: french, es: spanish }, "es");

  assert.deepEqual(i18n.message("game:report"), { text: spanish.game.report, language: "es" });
  assert.deepEqual(i18n.message("greeting"), { text: french.common.greeting, language: "fr" });
});

test("fallback messages use the source language's plural rules", () => {
  const english = createTranslator({ fr: french, en: {} }, "en");

  assert.equal(english.t("game:count", { count: 0 }), "0 noisette");
  assert.equal(english.t("game:count", { count: 1 }), "1 noisette");
  assert.equal(english.t("game:count", { count: 2 }), "2 noisettes");
});

test("exact zero wins over the French one category", () => {
  const i18n = createTranslator({ fr: french });

  assert.equal(i18n.t("game:butter", { count: 0 }), "Pas de beurre !");
  assert.equal(i18n.t("game:butter", { count: 1 }), "1 noisette dans la poche.");
  assert.equal(i18n.t("game:butter", { count: 2 }), "2 noisettes dans la poche.");
});

test("French select branches keep complete sentences and nested plurals together", () => {
  const i18n = createTranslator({ fr: french });

  assert.equal(
    i18n.t("game:report", { gender: "female", count: 1 }),
    "La maire a rapporté 1 noisette.",
  );
  assert.equal(
    i18n.t("game:report", { gender: "male", count: 2 }),
    "Le maire a rapporté 2 noisettes.",
  );
  assert.equal(
    i18n.t("game:report", { gender: "other", count: 0 }),
    "À la mairie, Quaso a rapporté 0 noisette.",
  );
  assert.equal(
    i18n.t("game:report", { gender: "unknown", count: 2 }),
    "À la mairie, Quaso a rapporté 2 noisettes.",
  );
});

test("Spanish can rephrase the neutral sentence without changing game code", () => {
  const i18n = createTranslator({ fr: french, es: spanish }, "es");

  assert.equal(
    i18n.t("game:report", { gender: "female", count: 1 }),
    "La alcaldesa ha traído 1 porción.",
  );
  assert.equal(
    i18n.t("game:report", { gender: "male", count: 2 }),
    "El alcalde ha traído 2 porciones.",
  );
  assert.equal(
    i18n.t("game:report", { gender: "other", count: 0 }),
    "La persona en la alcaldía ha traído 0 porciones.",
  );
  assert.equal(i18n.t("greeting", { name: "Quaso" }), "Bonjour, Quaso !");
  i18n.changeLanguage("fr");
  assert.equal(i18n.language, "fr");
  assert.equal(
    i18n.t("game:report", { gender: "female", count: 1 }),
    "La maire a rapporté 1 noisette.",
  );
});

test("arrays, ICU quoting, and markup stay plain text", () => {
  const i18n = createTranslator(
    {
      fr: french,
      en: { common: { greeting: "Hello, {name}! <b>Welcome</b>" } },
    },
    "en",
  );

  assert.deepEqual(i18n.t("game:meows", { returnObjects: true }), [
    "Miaou !",
    "{name} est un exemple.",
  ]);
  assert.equal(i18n.t("greeting", { name: "<img src=x>" }), "Hello, <img src=x>! <b>Welcome</b>");
});

function messages(value) {
  return typeof value === "string" ? [value] : Object.values(value).flatMap(messages);
}

test("every shipped catalog message is valid ICU, without legacy interpolation", async () => {
  const directory = new URL("../src/locales/", import.meta.url);
  for (const language of await readdir(directory)) {
    const languageDirectory = new URL(`${language}/`, directory);
    for (const file of await readdir(languageDirectory)) {
      const catalog = JSON.parse(await readFile(new URL(file, languageDirectory), "utf8"));
      for (const message of messages(catalog)) {
        assert.doesNotMatch(message, /\{\{\w+\}\}/, `${language}/${file}`);
        assert.doesNotThrow(
          () => new IntlMessageFormat(message, language, undefined, { ignoreTag: true }),
          `${language}/${file}: ${message}`,
        );
      }
    }
  }
});

test("malformed downloaded ICU falls back to French and the inspector shows that source", () => {
  const i18n = createTranslator(
    {
      fr: french,
      en: { game: { count: "{count, plural, one {# item} other {# items}" } },
    },
    "en",
  );

  assert.equal(i18n.t("game:count", { count: 0 }), "0 noisette");
  assert.deepEqual(i18n.message("game:count"), { text: french.game.count, language: "fr" });
  const brokenSource = createTranslator({ fr: { game: { count: "{count" } } });
  assert.throws(() => brokenSource.t("game:count", { count: 0 }));
});

test("a missing translated argument falls back per call without hiding source argument errors", () => {
  const i18n = createTranslator(
    {
      fr: french,
      en: { common: { greeting: "Hello, {name} and {visitor}!" } },
    },
    "en",
  );

  assert.equal(i18n.t("greeting", { name: "Quaso" }), "Bonjour, Quaso !");
  assert.deepEqual(i18n.message("greeting"), { text: french.common.greeting, language: "fr" });
  assert.equal(
    i18n.t("greeting", { name: "Quaso", visitor: "Biscotte" }),
    "Hello, Quaso and Biscotte!",
  );
  assert.deepEqual(i18n.message("greeting"), {
    text: "Hello, {name} and {visitor}!",
    language: "en",
  });
  assert.throws(() => i18n.t("greeting"), /name/);
  i18n.changeLanguage("fr");
  assert.throws(() => i18n.t("greeting"), /name/);
});
