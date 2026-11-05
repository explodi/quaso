// SPDX-License-Identifier: MIT
import { IntlMessageFormat } from "intl-messageformat";

/** Resolve a catalog entry before formatting, so fallback text keeps its own plural rules. */
export function createTranslator(resources, initialLanguage = "fr") {
  let language = initialLanguage;
  const formats = new Map();
  const displayedMessages = new Map();

  function resolve(key, requestedLanguage) {
    const [namespace, path] = key.includes(":") ? key.split(":") : ["common", key];
    const parts = path.split(".");
    const read = (locale) =>
      parts.reduce((entry, part) => entry?.[part], resources[locale]?.[namespace]);
    const translated = read(requestedLanguage);
    const hasTranslation = translated !== undefined && translated !== "";
    const locale = hasTranslation ? requestedLanguage : "fr";
    return { text: hasTranslation ? translated : read("fr"), language: locale };
  }

  function format(message, values) {
    const { text: pattern, language: locale } = message;
    const cacheKey = `${locale}:${pattern}`;
    if (!formats.has(cacheKey)) {
      // Every consumer uses textContent; translator-supplied markup stays literal text.
      formats.set(cacheKey, new IntlMessageFormat(pattern, locale, undefined, { ignoreTag: true }));
    }
    return formats.get(cacheKey).format(values);
  }

  function t(key, values = {}) {
    let message = resolve(key, language);
    if (Array.isArray(message.text) && values.returnObjects) {
      return message.text.map((_, index) => t(`${key}.${index}`, values));
    }
    if (typeof message.text !== "string") return key;

    let text;
    try {
      text = format(message, values);
    } catch (error) {
      // A broken download must not stop play; source errors still reveal a game bug.
      if (message.language === "fr") throw error;
      message = resolve(key, "fr");
      text = format(message, values);
    }
    displayedMessages.set(key, message);
    return text;
  }

  return {
    t,
    message(key) {
      return displayedMessages.get(key) ?? resolve(key, language);
    },
    get language() {
      return language;
    },
    changeLanguage(nextLanguage) {
      language = nextLanguage;
      displayedMessages.clear();
    },
  };
}
