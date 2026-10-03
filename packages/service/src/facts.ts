// SPDX-License-Identifier: MIT
/**
 * What the checks and the renderer need to know about the project, loaded once per
 * operation: the source language, the interpolation syntax and the languages.
 */
import type { GlossaryTerm, InterpolationSyntax, PluralOverride } from "@quaso/core";
import type { Context } from "./context.ts";
import { type Language, loadLanguages } from "./languages.ts";
import { listGlossary } from "./glossary.ts";
import { loadSettings } from "./settings.ts";

export interface Facts {
  sourceLanguage: string;
  glossary?: GlossaryTerm[];
  syntax: InterpolationSyntax;
  /** The project languages, by tag. */
  languages: Map<string, Language>;
}

/** Quality checks need glossary rules, without presentation or author metadata. */
export type CheckFacts = Omit<Facts, "glossary"> & {
  glossary?: Pick<GlossaryTerm, "term" | "language" | "kind" | "translation" | "caseSensitive">[];
};

export function loadFacts(ctx: Context): Facts {
  const settings = loadSettings(ctx);
  const languages = new Map(loadLanguages(ctx.sql).map((language) => [language.tag, language]));
  const glossary = listGlossary(ctx, {}).terms;
  return { sourceLanguage: settings.sourceLanguage, syntax: settings.syntax, languages, glossary };
}

/** A language's plural override, if the project has one for it. */
export function overrideOf(
  facts: Pick<Facts, "languages">,
  language: string,
): PluralOverride | undefined {
  return facts.languages.get(language)?.pluralOverride;
}
