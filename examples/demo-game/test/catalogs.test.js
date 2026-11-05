// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import frenchGame from "../src/locales/fr/game.json" with { type: "json" };
import spanishGame from "../src/locales/es/game.json" with { type: "json" };
import { createTranslator } from "../src/translator.js";

const resources = { fr: { game: frenchGame }, es: { game: spanishGame } };
const french = createTranslator(resources);
const spanish = createTranslator(resources, "es");

for (const language of ["fr", "es"]) {
  for (const state of ["ready", "playing", "won", "lost"]) {
    for (const gender of ["female", "male", "other"]) {
      for (const count of [0, 1, 2, 12]) {
        test(`${language} newspaper: ${state}, ${gender}, ${count}`, () => {
          const i18n = createTranslator(resources, language);
          const story = i18n.t(`game:newspaper.${state}`, { gender, count });
          assert.doesNotMatch(story, /[{}]|undefined|game:newspaper/);
          assert.ok(story.length > 0);
        });
      }
    }
  }
}

test("Spanish ready stories agree with feminine and masculine choices and rephrase neutral", () => {
  assert.equal(
    spanish.t("game:newspaper.ready", { gender: "female" }),
    "La alcaldesa del pícnic está lista para su primera misión: ¡mantequilla para todo el mundo!",
  );
  assert.equal(
    spanish.t("game:newspaper.ready", { gender: "male" }),
    "El alcalde del pícnic está listo para su primera misión: ¡mantequilla para todo el mundo!",
  );
  assert.equal(
    spanish.t("game:newspaper.ready", { gender: "other" }),
    "La persona en la alcaldía del pícnic tiene una primera misión: ¡mantequilla para todo el mundo!",
  );
});

test("Spanish progress stories combine pronouns with zero, singular and plural counts", () => {
  assert.equal(
    spanish.t("game:newspaper.playing", { gender: "female", count: 0 }),
    "La alcaldesa sigue buscando su primera porción de mantequilla. Ella no pierde la sonrisa.",
  );
  assert.equal(
    spanish.t("game:newspaper.playing", { gender: "male", count: 1 }),
    "El alcalde ha recogido 1 porción de mantequilla. Él sigue su recorrido.",
  );
  assert.equal(
    spanish.t("game:newspaper.playing", { gender: "other", count: 2 }),
    "La persona en la alcaldía ha recogido 2 porciones de mantequilla. El recorrido continúa.",
  );
  assert.equal(
    spanish.t("game:newspaper.playing", { gender: "female", count: 12 }),
    "La alcaldesa ha recogido 12 porciones de mantequilla. Ella sigue su recorrido.",
  );
});

test("Spanish reports keep object and subject pronouns consistent after delivery", () => {
  assert.equal(
    spanish.t("game:newspaper.won", { gender: "female", count: 12 }),
    "La alcaldesa ha entregado 12 porciones de mantequilla. Biscotte la felicita: ¡ella ha salvado la merienda!",
  );
  assert.equal(
    spanish.t("game:newspaper.won", { gender: "male", count: 12 }),
    "El alcalde ha entregado 12 porciones de mantequilla. Biscotte lo felicita: ¡él ha salvado la merienda!",
  );
  assert.equal(
    spanish.t("game:newspaper.won", { gender: "other", count: 12 }),
    "La persona en la alcaldía ha entregado 12 porciones de mantequilla. ¡Gracias, Quaso! ¡La merienda está a salvo!",
  );
});

test("Spanish failed-run stories include collected butter without assigning neutral pronouns", () => {
  assert.equal(
    spanish.t("game:newspaper.lost", { gender: "female", count: 0 }),
    "La alcaldesa vuelve sin mantequilla. Ella ya prepara su próximo recorrido.",
  );
  assert.equal(
    spanish.t("game:newspaper.lost", { gender: "male", count: 1 }),
    "El alcalde vuelve con 1 porción de mantequilla. Él ya prepara su próximo recorrido.",
  );
  assert.equal(
    spanish.t("game:newspaper.lost", { gender: "other", count: 2 }),
    "La persona en la alcaldía vuelve con 2 porciones de mantequilla. El próximo recorrido ya está en marcha.",
  );
});

test("French ready stories agree with the chosen pronouns", () => {
  assert.equal(
    french.t("game:newspaper.ready", { gender: "female" }),
    "La maire du pique-nique est prête pour sa première mission : du beurre pour tout le monde !",
  );
  assert.equal(
    french.t("game:newspaper.ready", { gender: "male" }),
    "Le maire du pique-nique est prêt pour sa première mission : du beurre pour tout le monde !",
  );
  assert.equal(
    french.t("game:newspaper.ready", { gender: "other" }),
    "À la tête du pique-nique, Quaso a une première mission : du beurre pour tout le monde !",
  );
});

test("French progress stories combine pronouns and nested plurals", () => {
  assert.equal(
    french.t("game:newspaper.playing", { gender: "female", count: 0 }),
    "La maire cherche encore sa première noisette de beurre. Elle garde le sourire.",
  );
  assert.equal(
    french.t("game:newspaper.playing", { gender: "male", count: 1 }),
    "Le maire a ramassé 1 noisette de beurre. Il poursuit sa tournée.",
  );
  assert.equal(
    french.t("game:newspaper.playing", { gender: "other", count: 2 }),
    "À la tête du pique-nique, Quaso a ramassé 2 noisettes de beurre. La tournée continue.",
  );
  assert.equal(
    french.t("game:newspaper.playing", { gender: "female", count: 12 }),
    "La maire a ramassé 12 noisettes de beurre. Elle poursuit sa tournée.",
  );
});

test("French delivery stories keep object and subject pronouns consistent", () => {
  assert.equal(
    french.t("game:newspaper.won", { gender: "female", count: 12 }),
    "La maire a livré 12 noisettes de beurre. Biscotte la félicite : elle a sauvé le goûter !",
  );
  assert.equal(
    french.t("game:newspaper.won", { gender: "male", count: 12 }),
    "Le maire a livré 12 noisettes de beurre. Biscotte le félicite : il a sauvé le goûter !",
  );
  assert.equal(
    french.t("game:newspaper.won", { gender: "other", count: 12 }),
    "À la tête du pique-nique, Quaso a livré 12 noisettes de beurre. Bravo, Quaso : le goûter est sauvé !",
  );
});

test("French failed-run stories keep neutral wording natural", () => {
  assert.equal(
    french.t("game:newspaper.lost", { gender: "female", count: 0 }),
    "La maire rentre sans beurre. Elle prépare déjà sa prochaine tournée.",
  );
  assert.equal(
    french.t("game:newspaper.lost", { gender: "male", count: 1 }),
    "Le maire rentre avec 1 noisette de beurre. Il prépare déjà sa prochaine tournée.",
  );
  assert.equal(
    french.t("game:newspaper.lost", { gender: "other", count: 2 }),
    "À la tête du pique-nique, Quaso rentre avec 2 noisettes de beurre. La prochaine tournée se prépare déjà.",
  );
});

test("French dialogue and medals follow the same gender argument as the newspaper", () => {
  assert.equal(french.t("game:biscotte.ready", { gender: "female" }), "Par ici, madame la maire !");
  assert.equal(french.t("game:biscotte.ready", { gender: "male" }), "Par ici, monsieur le maire !");
  assert.equal(
    french.t("game:biscotte.ready", { gender: "other" }),
    "Par ici, Quaso ! Le goûter t'attend !",
  );
  assert.equal(french.t("game:win.rank1", { gender: "female" }), "Apprentie tartine !");
  assert.equal(french.t("game:win.rank1", { gender: "male" }), "Apprenti tartine !");
  assert.equal(french.t("game:win.rank1", { gender: "other" }), "La relève des tartines !");
  assert.equal(
    french.t("game:win.tip3", { gender: "female" }),
    "Rapide, impeccable, irrésistiblement beurrée. Biscotte te confie les clés de la boulangerie.",
  );
  assert.equal(
    french.t("game:win.tip3", { gender: "male" }),
    "Rapide, impeccable, irrésistiblement beurré. Biscotte te confie les clés de la boulangerie.",
  );
  assert.equal(
    french.t("game:win.tip3", { gender: "other" }),
    "Du talent, du panache et du beurre. Biscotte te confie les clés de la boulangerie.",
  );
});

test("Spanish medal adjectives agree with the player and neutral wording avoids gender", () => {
  assert.equal(
    spanish.t("game:win.tip3", { gender: "female" }),
    "Rápida, impecable, irresistiblemente untada de mantequilla. Biscotte te confía las llaves de la panadería.",
  );
  assert.equal(
    spanish.t("game:win.tip3", { gender: "male" }),
    "Rápido, impecable, irresistiblemente untado de mantequilla. Biscotte te confía las llaves de la panadería.",
  );
  assert.equal(
    spanish.t("game:win.tip3", { gender: "other" }),
    "Talento, estilo y mantequilla. Biscotte te confía las llaves de la panadería.",
  );
});
