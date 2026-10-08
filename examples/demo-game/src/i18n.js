// SPDX-License-Identifier: MIT
/** Quaso writes ordinary JSON. The game only needs i18next, never a Quaso connection. */
import i18next from "i18next";

export const languages = { fr: "Français", en: "English", de: "Deutsch" };
export const namespaces = ["common", "game"];

// Vite includes every catalog in the build, including files downloaded by quaso download.
const catalogs = import.meta.glob("./locales/*/*.json", { eager: true, import: "default" });
const resources = {};
for (const language of Object.keys(languages)) {
  resources[language] = {};
  for (const namespace of namespaces) {
    resources[language][namespace] = catalogs[`./locales/${language}/${namespace}.json`] ?? {};
  }
}

const requested = new URLSearchParams(location.search).get("lang");
await i18next.init({
  lng: Object.hasOwn(languages, requested) ? requested : "fr",
  fallbackLng: "fr",
  supportedLngs: Object.keys(languages),
  resources,
  defaultNS: "common",
  returnEmptyString: false,
  interpolation: { escapeValue: false }, // UI strings use textContent, never HTML.
});

export const t = i18next.t.bind(i18next);

export async function changeLanguage(language) {
  if (!Object.hasOwn(languages, language)) return;
  await i18next.changeLanguage(language);
  document.documentElement.lang = language;
  const url = new URL(location.href);
  url.searchParams.set("lang", language);
  history.replaceState(null, "", url);
}

export { i18next };
