// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstance } from "i18next";
import common from "../src/locales/fr/common.json" with { type: "json" };
import game from "../src/locales/fr/game.json" with { type: "json" };

async function untranslated(language) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: "fr",
    supportedLngs: ["fr", "en", "de"],
    defaultNS: "common",
    resources: { fr: { common, game }, en: {}, de: {} },
    returnEmptyString: false,
    interpolation: { escapeValue: false },
  });
  return i18n;
}

test("untranslated English and German use the French source catalogs", async () => {
  const english = await untranslated("en");
  const german = await untranslated("de");

  assert.equal(english.t("game:welcome.title"), "Le goûter n'attend pas !");
  assert.equal(german.t("game:welcome.title"), "Le goûter n'attend pas !");
  assert.equal(english.t("game:quest.progress", { current: 3, total: 12 }), "3 / 12");
  assert.equal(german.t("game:score", { score: 200 }), "200 points");
  assert.equal(english.t("controls.space"), "espace");
});

test("French fallback retains the zero, singular, and plural butter messages", async () => {
  const english = await untranslated("en");

  assert.equal(
    english.t("game:quest.butter", { count: 0 }),
    "Aucune noisette de beurre. Pour l'instant !",
  );
  assert.equal(english.t("game:quest.butter", { count: 1 }), "1 noisette de beurre dans la poche.");
  assert.equal(
    english.t("game:quest.butter", { count: 2 }),
    "2 noisettes de beurre dans la poche.",
  );
});

test("downloaded translations replace source text while unfinished keys keep falling back", async () => {
  const english = await untranslated("en");
  english.addResourceBundle("en", "game", {
    welcome: { title: "Snack time!", body: "" },
    quest: { butter_one: "{{count}} butter pat", butter_other: "{{count}} butter pats" },
  });

  assert.equal(english.t("game:welcome.title"), "Snack time!");
  assert.equal(english.t("game:welcome.body"), game.welcome.body);
  assert.equal(english.t("controls.space"), "espace");
  assert.equal(english.t("game:quest.butter", { count: 1 }), "1 butter pat");
  assert.equal(english.t("game:quest.butter", { count: 2 }), "2 butter pats");
});
