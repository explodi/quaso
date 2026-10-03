// SPDX-License-Identifier: MIT
/**
 * `quaso status` (design §5.10, S4.7, CLI-6): progress per language, as a table or JSON.
 * `--fail-on` exits with code 7 when a string of the config's languages is untranslated,
 * outdated or not yet proofread, so CI can hold a release back.
 */
import { isValidLanguageTag, type StatusResult } from "@quaso/core";
import { values } from "../args.ts";
import { canonical } from "../config.ts";
import type { Command, Context } from "../context.ts";
import { EXIT, usageError } from "../errors.ts";
import { count, type Output, table } from "../output.ts";

export const FAIL_ON = ["untranslated", "outdated", "green"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface FailOnHit {
  language: string;
  state: FailOn;
  /** Strings in that state; for a language the instance lacks, every string. */
  count: number;
}

export const status: Command = {
  name: "status",
  summary: "Show progress per language: untranslated, green, blue, outdated, pending, QA",
  description: [
    "Shows, for every language of the instance, how many strings are untranslated, " +
      "translated but not proofread (green), proofread (blue), outdated (made for older " +
      "English), waiting for review (pending) and failing the quality checks (QA), and the " +
      "translated and proofread share of the words.",
    "--fail-on makes it exit with code 7 when a string of the config's languages (or of " +
      "--language) is in one of the given states. green means translated but not yet " +
      "proofread.",
  ],
  options: [
    {
      name: "language",
      type: "list",
      value: "<lang>",
      description: "Only these languages (repeatable, or a comma list)",
    },
    {
      name: "fail-on",
      type: "list",
      value: "<state>",
      choices: FAIL_ON,
      description:
        "Exit with code 7 when a string is untranslated, outdated or green " +
        "(not proofread); repeatable, or a comma list",
    },
  ],
  exitCodes: [0, 1, 2, 3, 4, 7],
  examples: [
    "quaso status",
    "quaso status --language de,fr",
    "quaso status --fail-on untranslated,outdated",
    "quaso status --json",
  ],
  async run(ctx: Context) {
    const project = await ctx.project();
    for (const tag of values(ctx.args, "language")) {
      if (!isValidLanguageTag(tag)) {
        throw usageError(`--language ${tag} isn't a valid BCP 47 language tag.`);
      }
    }
    const requested = [...new Set(values(ctx.args, "language").map(canonical))];
    const failOn = values(ctx.args, "fail-on") as FailOn[];
    const client = ctx.client(project);
    // Every language, whatever --language says: one or several are handled the same way.
    const status = await client.get<StatusResult>("/status");

    const available = new Set(status.languages.map((language) => language.tag));
    const configured = new Set(project.languages);
    for (const language of requested) {
      if (language === canonical(status.sourceLanguage)) {
        throw usageError(`${language} is the source language, which has no progress.`);
      }
      // A config language the instance lacks is counted below (every string untranslated).
      if (!available.has(language) && !configured.has(language)) {
        throw usageError(
          `The instance has no language ${language}, and ${project.configName} doesn't list it.`,
          {
            code: "unknown_language",
            hint: `The instance has ${[...available].join(", ") || "none"}.`,
          },
        );
      }
    }
    const shown =
      requested.length > 0
        ? status.languages.filter((language) => requested.includes(language.tag))
        : status.languages;
    const counted = requested.length > 0 ? requested : project.languages;
    const missing = counted.filter((language) => !available.has(language));
    for (const language of missing) {
      ctx.out.warn(
        `${language} is in ${project.configName} but not on the instance yet; quaso upload adds it.`,
      );
    }

    const strings = status.languages[0]?.strings ?? 0;
    const hits: FailOnHit[] = [];
    for (const state of FAIL_ON.filter((state) => failOn.includes(state))) {
      for (const tag of counted) {
        const language = status.languages.find((entry) => entry.tag === tag);
        const found = language ? language[state] : state === "untranslated" ? strings : 0;
        if (found > 0) hits.push({ language: tag, state, count: found });
      }
    }
    const exitCode = hits.length > 0 ? EXIT.failOn : EXIT.ok;
    const json = {
      server: client.baseUrl,
      revision: status.revision,
      sourceLanguage: status.sourceLanguage,
      languages: shown.map((language) => ({ ...language, inConfig: configured.has(language.tag) })),
      missing,
      failOn: failOn.length > 0 ? { states: failOn, met: hits.length > 0, hits } : null,
    };
    return {
      exitCode,
      json,
      render: (out: Output) => renderStatus(out, json, failOn),
    };
  },
};

function renderStatus(
  out: Output,
  result: {
    sourceLanguage: string;
    languages: (StatusResult["languages"][number] & { inConfig: boolean })[];
    missing: string[];
    failOn: { met: boolean; hits: FailOnHit[] } | null;
  },
  failOn: FailOn[],
): void {
  const { bold, dim, green, blue, red, yellow } = out.out;
  const first = result.languages[0];
  if (first) {
    out.print(
      `${count(first.strings, "string")}, ${count(first.words, "word")} ` +
        `(source language: ${result.sourceLanguage})`,
    );
    out.print();
  }
  if (result.languages.length === 0) {
    out.print(
      result.missing.length > 0
        ? `The instance doesn't have ${result.missing.join(", ")} yet: quaso upload adds ` +
            `${result.missing.length === 1 ? "it" : "them"}.`
        : "The instance has no languages yet: quaso upload adds the config's.",
    );
  } else {
    const number = (value: number, style: (text: string) => string) =>
      value > 0 ? style(String(value)) : dim("0");
    const rows = [
      [
        "Language",
        "Untranslated",
        "Green",
        "Blue",
        "Outdated",
        "Pending",
        "QA",
        "Translated • Proofread",
      ].map(bold),
      ...result.languages.map((language) => [
        `${language.tag.padEnd(6)} ${language.name}${language.inConfig ? "" : dim(" *")}`,
        number(language.untranslated, red),
        number(language.green, green),
        number(language.blue, blue),
        number(language.outdated, yellow),
        number(language.pending, (text) => text),
        number(language.qa, red),
        `${language.translatedPercent}% • ${language.proofreadPercent}%`,
      ]),
    ];
    for (const line of table(rows, { right: [1, 2, 3, 4, 5, 6] })) out.print(line);
    if (result.languages.some((language) => !language.inConfig)) {
      out.print(dim("* not in quaso.config.json: --fail-on leaves it out"));
    }
  }
  if (result.failOn) {
    out.print();
    if (result.failOn.met) {
      const list = result.failOn.hits.map((hit) => `${hit.language}: ${hit.count} ${hit.state}`);
      out.print(red(`--fail-on ${failOn.join(",")}: met (${list.join(", ")})`));
    } else {
      out.print(green(`--fail-on ${failOn.join(",")}: not met`));
    }
  }
}
