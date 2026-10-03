// SPDX-License-Identifier: MIT
/**
 * Formatting for people: numbers, percentages, progress ("translated % • proofread %"),
 * dates relative to now, and language names. The website's own text is in English.
 */
import { languageName, type Progress, type TextValue } from "@quaso/core";

const LOCALE = "en";
const numbers = new Intl.NumberFormat(LOCALE);
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

export function formatNumber(value: number): string {
  return numbers.format(value);
}

/** `1 word`, `12 words`, `1,200 strings`. */
export function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

/** A percentage from 0–100: `45%`. */
export function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.floor(value)))}%`;
}

/** "45% translated • 10% proofread" */
export function progressText(
  progress: Pick<Progress, "translatedPercent" | "proofreadPercent">,
): string {
  return `${formatPercent(progress.translatedPercent)} translated • ${formatPercent(
    progress.proofreadPercent,
  )} proofread`;
}

/** "120 words left", or "Nothing left" when every word is translated. */
export function wordsLeftText(progress: Pick<Progress, "wordsLeft">): string {
  return progress.wordsLeft === 0 ? "Nothing left" : `${count(progress.wordsLeft, "word")} left`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "5 minutes ago", "yesterday", "just now". */
export function formatRelative(at: number, now: number = Date.now()): string {
  const difference = at - now;
  const size = Math.abs(difference);
  if (size < 45_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (size >= ms || unit === "minute") {
      return relative.format(Math.round(difference / ms), unit);
    }
  }
  return "just now";
}

/** "Sep 24, 2026, 7:15 AM" */
export function formatDateTime(at: number): string {
  return dateTime.format(new Date(at));
}

/** The language's English name: "German", "Portuguese (Brazil)". */
export function languageLabel(tag: string): string {
  return languageName(tag, LOCALE);
}

/** A translation value as one line of text, for lists: plural forms joined. */
export function valueText(value: TextValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return Object.entries(value)
    .map(([form, text]) => `${form}: ${text ?? ""}`)
    .join(" · ");
}

/** The English to show in a one-line list: the text, or a plural string's `other` form. */
export function sourcePreview(value: TextValue): string {
  if (typeof value === "string") return value;
  return value.other ?? Object.values(value).find((text) => text !== undefined) ?? "";
}
