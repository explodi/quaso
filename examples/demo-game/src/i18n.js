// SPDX-License-Identifier: MIT
/** Load the JSON files Quaso downloads. No build step or runtime Quaso connection. */
import { readFile } from "node:fs/promises";
import i18next from "i18next";
import { hud } from "./game.js";

const language = process.argv[2] ?? "en";
if (!["en", "de", "fr", "pl", "ja", "ar", "pt-BR"].includes(language)) {
  throw new Error("Choose a language listed in quaso.config.json, or en.");
}
const resources = {};
for (const lang of new Set(["en", language])) {
  resources[lang] = {};
  for (const namespace of ["common", "menus", "store"]) {
    const file = new URL(`./locales/${lang}/${namespace}.json`, import.meta.url);
    try {
      resources[lang][namespace] = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      // Languages not downloaded yet use the source-language fallback.
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await i18next.init({ lng: language, fallbackLng: "en", resources, defaultNS: "common" });
console.log(
  hud(i18next.t.bind(i18next), {
    name: "Alex",
    level: 3,
    coins: 12,
    lives: 2,
    items: ["map"],
    companion: "cat",
  }).join("\n"),
);
