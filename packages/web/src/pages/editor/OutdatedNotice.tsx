// SPDX-License-Identifier: MIT
/**
 * The banner over an outdated translation: how the English changed, what players get
 * meanwhile, and how to make the translation current again. The English the translation was
 * made for comes from the string's history, which the History tab shares (same query key).
 */
import { ClockIcon, Notice } from "@quaso/design-system";
import type { HistoryEntry, HistoryResult, StringDetail, TextValue } from "@quaso/core";
import { getHistory } from "../../lib/api.ts";
import { useQuery } from "../../lib/data.ts";
import { wordDiff } from "../../lib/diff.ts";
import { outdatedExplanation } from "../../lib/states.ts";

export function OutdatedNotice({
  detail,
  sourceLanguage,
  sourceLanguageName,
  canEdit,
  canSuggest,
}: {
  detail: StringDetail;
  sourceLanguage: string;
  sourceLanguageName: string;
  canEdit: boolean;
  canSuggest: boolean;
}) {
  const translation = detail.translation;
  const outdated = translation?.outdated === true;
  const history = useQuery<HistoryResult>(
    outdated ? ["history", detail.id, detail.language] : null,
    ({ fresh }) => getHistory(detail.id, detail.language, { fresh }),
    { staleTime: 5_000 },
  );
  if (!outdated) return null;
  const madeFor = englishWhenTranslated(history.data?.entries ?? [], translation.updatedAt);
  const llmProposal = detail.suggestions.some(
    (suggestion) => suggestion.kind === "llm" && suggestion.status === "pending",
  );
  return (
    <Notice
      kind="warning"
      icon={<ClockIcon />}
      title="Outdated translation"
      className="outdated-notice"
    >
      <p>{outdatedExplanation(sourceLanguageName)}</p>
      {madeFor !== null && (
        <EnglishChange
          before={madeFor}
          after={detail.source}
          lang={sourceLanguage}
          sourceLanguageName={sourceLanguageName}
        />
      )}
      {llmProposal && <p>The LLM proposed an update. Review it in the Suggestions tab.</p>}
      {canEdit && <p>Update the translation and save it, or choose Approve if it still fits.</p>}
      {canSuggest && <p>Suggest an updated translation. A manager will review it.</p>}
    </Notice>
  );
}

/** The English before and after, as a word diff: removed words struck out, new ones marked. */
function EnglishChange({
  before,
  after,
  lang,
  sourceLanguageName,
}: {
  before: TextValue;
  after: TextValue;
  lang: string;
  sourceLanguageName: string;
}) {
  return (
    <div className="outdated-change">
      <p className="outdated-change-label">What changed in the {sourceLanguageName}</p>
      {formsOf(before, after).map(([form, old, current]) => (
        <p key={form} className="outdated-change-text" lang={lang} dir="auto">
          {form !== "text" && <span className="form-name">{form} </span>}
          {wordDiff(old, current).map((part, index) =>
            part.kind === "added" ? (
              <ins key={index}>{part.text}</ins>
            ) : part.kind === "removed" ? (
              <del key={index}>{part.text}</del>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** Pairs of old and new text: one for a text string, one per form for a plural string. */
function formsOf(before: TextValue, after: TextValue): [string, string, string][] {
  if (typeof before === "string" && typeof after === "string") return [["text", before, after]];
  const old = typeof before === "string" ? { other: before } : before;
  const current = typeof after === "string" ? { other: after } : after;
  const forms = [...new Set([...Object.keys(old), ...Object.keys(current)])];
  return forms.map((form) => [
    form,
    old[form as keyof typeof old] ?? "",
    current[form as keyof typeof current] ?? "",
  ]);
}

/**
 * The English a translation was made for: the "before" of the first change to the English
 * after the translation was last written. Null when the history doesn't say, such as for an
 * import that was already outdated.
 */
export function englishWhenTranslated(
  entries: readonly HistoryEntry[],
  translatedAt: number,
): TextValue | null {
  const changesAfter = entries.filter((entry) => {
    const changesEnglish = entry.event === "source_changed" || entry.event === "source_restored";
    return changesEnglish && entry.before !== null && entry.createdAt >= translatedAt;
  });
  // Entries come newest first: the last one is the first change after the translation.
  return changesAfter.at(-1)?.before ?? null;
}
