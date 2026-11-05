// SPDX-License-Identifier: MIT
/** Quaso writes ICU messages in ordinary JSON; the built game needs no Quaso connection. */
import { createTranslator } from "./translator.js";

export const languages = { fr: "Français", es: "Español", en: "English", de: "Deutsch" };
export const namespaces = ["common", "game"];

// Vite includes every catalog in the build, including files downloaded by quaso download.
const catalogs = import.meta.glob(["./locales/*/*.json", "!./locales/*/*.descriptions.json"], {
  eager: true,
  import: "default",
});
const resources = {};
for (const language of Object.keys(languages)) {
  resources[language] = {};
  for (const namespace of namespaces) {
    resources[language][namespace] = catalogs[`./locales/${language}/${namespace}.json`] ?? {};
  }
}

const requested = new URLSearchParams(location.search).get("lang");
export const i18n = createTranslator(
  resources,
  Object.hasOwn(languages, requested) ? requested : "fr",
);
export const t = i18n.t;

export async function changeLanguage(language) {
  if (!Object.hasOwn(languages, language)) return;
  i18n.changeLanguage(language);
  document.documentElement.lang = language;
  const url = new URL(location.href);
  url.searchParams.set("lang", language);
  history.replaceState(null, "", url);
}
