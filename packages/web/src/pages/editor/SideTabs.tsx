// SPDX-License-Identifier: MIT
/**
 * The translation panel's tabs (S7.7): the history (who changed what, when, before and after,
 * with colour changes; STR-5), the suggestions (approve or reject for managers, withdraw for
 * their author) and the same string in the other languages.
 */
import {
  type HistoryEntry,
  type HistoryEvent,
  type HistoryResult,
  type StringDetail,
  type SuggestionInfo,
  textDirection,
  type TextValue,
} from "@quaso/core";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { ArrowLeftIcon, WarningIcon } from "../../components/Icons.tsx";
import { Loading } from "../../components/Spinner.tsx";
import { ColourLabel, StateMarker } from "../../components/StateBadge.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { useToast } from "../../components/Toast.tsx";
import { ApiError, getHistory, reviewSuggestions, withdrawSuggestion } from "../../lib/api.ts";
import { useQuery } from "../../lib/data.ts";
import { formatDateTime, formatRelative } from "../../lib/format.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { CommentsPanel, GlossaryPanel } from "./CommunityTabs.tsx";
import { editorHref } from "../LanguagePage.tsx";

export type SideTab = "history" | "suggestions" | "languages" | "comments" | "glossary";

export function SideTabs({
  detail,
  tab,
  onTab,
  onChanged,
  sourceLanguage,
}: {
  detail: StringDetail;
  tab: SideTab;
  onTab(tab: SideTab): void;
  onChanged(ids: number[]): Promise<void>;
  sourceLanguage: string;
}) {
  const pending = detail.suggestions.filter((s) => s.status === "pending").length;
  return (
    <Tabs
      label="About this string"
      selected={tab}
      onSelect={(id) => onTab(id as SideTab)}
      tabs={[
        { id: "history", label: "History" },
        {
          id: "suggestions",
          label: <>Suggestions{pending > 0 && <span className="tab-count">{pending}</span>}</>,
        },
        { id: "languages", label: "Other languages" },
        { id: "glossary", label: "Glossary" },
        { id: "comments", label: "Comments" },
      ]}
    >
      {tab === "history" && <History detail={detail} sourceLanguage={sourceLanguage} />}
      {tab === "suggestions" && <Suggestions detail={detail} onChanged={onChanged} />}
      {tab === "languages" && <OtherLanguages detail={detail} />}
      {tab === "glossary" && <GlossaryPanel detail={detail} />}
      {tab === "comments" && (
        <CommentsPanel key={`${detail.id}:${detail.language}`} detail={detail} />
      )}
    </Tabs>
  );
}

function Value({ value, lang }: { value: TextValue | null; lang: string }) {
  if (value === null) return <span className="muted">(none)</span>;
  const dir = textDirection(lang);
  if (typeof value === "string") {
    return (
      <span className="value-text" lang={lang} dir={dir}>
        {value}
      </span>
    );
  }
  return (
    <span className="plural-forms">
      {Object.entries(value).map(([form, text]) => (
        <span key={form} className="plural-form">
          <span className="form-name">{form}</span>{" "}
          <span lang={lang} dir={dir}>
            {text}
          </span>
        </span>
      ))}
    </span>
  );
}

const EVENT_LABELS: Record<HistoryEvent, string> = {
  source_added: "English added",
  source_changed: "English changed",
  source_removed: "English removed",
  source_restored: "English restored",
  source_renamed: "Key renamed",
  translation_saved: "Translation saved",
  translation_llm: "Translated by the LLM",
  translation_imported: "Imported",
  translation_approved: "Approved",
  translation_unapproved: "Unapproved",
  translation_deleted: "Deleted",
  suggestion_created: "Suggestion sent",
  suggestion_approved: "Suggestion approved",
  suggestion_rejected: "Suggestion rejected",
  suggestion_withdrawn: "Suggestion withdrawn",
  suggestion_superseded: "Suggestion superseded",
};

function When({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {formatRelative(at)}
    </time>
  );
}

function History({ detail, sourceLanguage }: { detail: StringDetail; sourceLanguage: string }) {
  const history = useQuery<HistoryResult>(
    ["history", detail.id, detail.language],
    ({ fresh }) => getHistory(detail.id, detail.language, { fresh }),
    { staleTime: 5_000 },
  );
  if (history.loading) return <Loading label="Loading the history…" />;
  if (history.error !== undefined && !history.data) {
    return <ErrorMessage error={history.error} onRetry={() => history.refresh()} />;
  }
  const entries = history.data?.entries ?? [];
  if (entries.length === 0) return <p className="muted pad">No history yet.</p>;
  return (
    <ol className="history">
      {entries.map((entry) => (
        <HistoryItem key={entry.id} entry={entry} sourceLanguage={sourceLanguage} />
      ))}
    </ol>
  );
}

function HistoryItem({ entry, sourceLanguage }: { entry: HistoryEntry; sourceLanguage: string }) {
  const lang = entry.language ?? sourceLanguage;
  const comment = typeof entry.detail?.comment === "string" ? entry.detail.comment : null;
  const colourChanged = entry.beforeColour !== entry.afterColour;
  return (
    <li className="history-item">
      <p className="history-head">
        <strong>
          {entry.event === "source_renamed" && typeof entry.detail?.from === "string"
            ? `Renamed from ${entry.detail.from}`
            : (EVENT_LABELS[entry.event] ?? entry.event)}
        </strong>
        <span className="muted">
          by {entry.actor.name}, <When at={entry.createdAt} />
        </span>
      </p>
      {colourChanged && (entry.beforeColour || entry.afterColour) && (
        <p className="history-colours">
          <ColourLabel colour={entry.beforeColour ?? "red"} />
          <ArrowLeftIcon className="arrow-right" /> <span className="sr-only">became</span>{" "}
          <ColourLabel colour={entry.afterColour ?? "red"} />
        </p>
      )}
      {(entry.before !== null || entry.after !== null) && (
        <div className="history-values">
          {entry.before !== null && (
            <p className="before">
              <span className="value-label">Before</span> <Value value={entry.before} lang={lang} />
            </p>
          )}
          {entry.after !== null && (
            <p className="after">
              <span className="value-label">After</span> <Value value={entry.after} lang={lang} />
            </p>
          )}
        </div>
      )}
      {comment && <p className="history-comment">“{comment}”</p>}
    </li>
  );
}

const KIND_LABELS: Record<SuggestionInfo["kind"], string> = {
  translation: "Translation",
  correction: "Correction",
  approval: "Looks good",
  llm: "LLM proposal",
};

const STATUS_LABELS: Record<SuggestionInfo["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

function Suggestions({
  detail,
  onChanged,
}: {
  detail: StringDetail;
  onChanged(ids: number[]): Promise<void>;
}) {
  const session = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const canReview = session.can("review", detail.language);
  const me = session.user?.id;

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setError(undefined);
    try {
      const message = await action();
      if (message) toast.show(message);
      await onChanged([detail.id]);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  const review = (suggestion: SuggestionInfo, action: "approve" | "reject") =>
    run(`${action}:${suggestion.id}`, async () => {
      const result = await reviewSuggestions({ ids: [suggestion.id], action });
      const failed = result.failed[0];
      if (failed) {
        throw new ApiError(422, failed.code, failed.checks?.[0]?.message ?? failed.message);
      }
      return action === "approve" ? "Approved: the string is proofread (blue)." : "Rejected.";
    });

  if (detail.suggestions.length === 0) {
    return (
      <EmptyState title="No suggestions">
        <p>
          Suggestions from contributors, and LLM proposals for proofread strings, wait here for
          review.
        </p>
      </EmptyState>
    );
  }
  const sorted = [...detail.suggestions].sort(
    (a, b) =>
      Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt - a.createdAt,
  );
  return (
    <div>
      {error !== undefined && <ErrorMessage error={error} />}
      <ul className="suggestions">
        {sorted.map((suggestion) => {
          const mine =
            me !== undefined && suggestion.author.type === "user" && suggestion.author.id === me;
          const pending = suggestion.status === "pending";
          const errors = suggestion.checks.filter((c) => c.severity === "error");
          return (
            <li key={suggestion.id} className={`suggestion suggestion-${suggestion.status}`}>
              <p className="suggestion-head">
                <strong>{KIND_LABELS[suggestion.kind]}</strong>
                <span className="muted">
                  by {suggestion.author.name}, <When at={suggestion.createdAt} />
                </span>
                <span className={`status status-${suggestion.status}`}>
                  {STATUS_LABELS[suggestion.status]}
                </span>
              </p>
              {suggestion.value !== null ? (
                <p className="suggestion-value">
                  <Value value={suggestion.value} lang={detail.language} />
                </p>
              ) : (
                <p className="muted">The current translation looks good to them.</p>
              )}
              {errors.length > 0 && (
                <ul className="checks">
                  {errors.map((check, index) => (
                    <li key={index} className="check check-error">
                      <WarningIcon /> {check.message}
                    </li>
                  ))}
                </ul>
              )}
              {suggestion.reviewer && (
                <p className="muted small">
                  Reviewed by {suggestion.reviewer.name}
                  {suggestion.reviewedAt !== null && (
                    <>
                      , <When at={suggestion.reviewedAt} />
                    </>
                  )}
                  {suggestion.comment && <>: “{suggestion.comment}”</>}
                </p>
              )}
              {pending && (canReview || mine) && (
                <div className="actions">
                  {canReview && (
                    <>
                      <Button
                        size="small"
                        variant="primary"
                        busy={busy === `approve:${suggestion.id}`}
                        disabled={busy !== null}
                        onClick={() => review(suggestion, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        size="small"
                        busy={busy === `reject:${suggestion.id}`}
                        disabled={busy !== null}
                        onClick={() => review(suggestion, "reject")}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {mine && (
                    <Button
                      size="small"
                      variant="ghost"
                      busy={busy === `withdraw:${suggestion.id}`}
                      disabled={busy !== null}
                      onClick={() =>
                        run(`withdraw:${suggestion.id}`, async () => {
                          await withdrawSuggestion(suggestion.id);
                          return "Suggestion withdrawn.";
                        })
                      }
                    >
                      Withdraw
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OtherLanguages({ detail }: { detail: StringDetail }) {
  if (detail.otherLanguages.length === 0) {
    return <p className="muted pad">The project has no other languages.</p>;
  }
  return (
    <ul className="other-languages">
      {detail.otherLanguages.map((other) => (
        <li key={other.language} className="other-language">
          <p className="other-head">
            <StateMarker summary={{ translation: other.translation, pending: 0 }} />
            <Link to={`${editorHref(other.language, { id: detail.id })}`}>{other.name}</Link>
          </p>
          {other.translation ? (
            <p className="other-value">
              <Value value={other.translation.value} lang={other.language} />
            </p>
          ) : (
            <p className="muted small">Untranslated</p>
          )}
        </li>
      ))}
    </ul>
  );
}
