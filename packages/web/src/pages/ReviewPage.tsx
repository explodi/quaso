// SPDX-License-Identifier: MIT
import { Label, Checkbox } from "../components/Controls.tsx";
import { H3, H1, H2 } from "../components/Typography.tsx";
/** Pending proposals and the contributor's own history, using the same review contract. */
import type { ReviewResult, SuggestionInfo, TextValue } from "@quaso/core";
import { useState } from "react";
import { Button } from "../components/Button.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Field } from "../components/Field.tsx";
import { Access, ConfirmButton, SelectField, TextField } from "../components/Management.tsx";
import { Loading } from "../components/Spinner.tsx";
import { useToast } from "../components/Toast.tsx";
import { listFiles, withdrawSuggestion } from "../lib/api.ts";
import { useMutation, useQuery } from "../lib/data.ts";
import { wordDiff } from "../lib/diff.ts";
import { fieldError } from "../lib/forms.ts";
import { formatDateTime } from "../lib/format.ts";
import { useDebounced, useDocumentTitle, useProject } from "../lib/hooks.ts";
import { listSuggestions, review } from "../lib/management-api.ts";
import { Link } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { editorHref } from "./LanguagePage.tsx";

export function valueText(value: TextValue | null): string {
  if (value === null) return "";
  return typeof value === "string"
    ? value
    : Object.entries(value)
        .map(([form, text]) => `${form}: ${text}`)
        .join("\n");
}

function Proposal({ suggestion }: { suggestion: SuggestionInfo }) {
  const current = valueText(suggestion.current?.value ?? null);
  const proposal = suggestion.value === null ? current : valueText(suggestion.value);
  return (
    <div className="review-diff">
      <div>
        <H3>English</H3>
        <p className="value-text">{valueText(suggestion.source)}</p>
      </div>
      <div>
        <H3>Current translation</H3>
        <p className="value-text" lang={suggestion.language} dir="auto">
          {current || "Untranslated"}
        </p>
      </div>
      <div>
        <H3>Proposal</H3>
        <p className="value-text" lang={suggestion.language} dir="auto">
          {wordDiff(current, proposal).map((part, index) =>
            part.kind === "added" ? (
              <ins key={index}>{part.text}</ins>
            ) : part.kind === "removed" ? (
              <del key={index}>{part.text}</del>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </p>
        {suggestion.kind === "approval" && (
          <p className="muted">The current translation looks good.</p>
        )}
      </div>
    </div>
  );
}

export function ReviewPage() {
  return (
    <Access action="review">
      <SuggestionsPage mine={false} />
    </Access>
  );
}
export function ContributionsPage() {
  return (
    <Access>
      <SuggestionsPage mine />
    </Access>
  );
}

function SuggestionsPage({ mine }: { mine: boolean }) {
  useDocumentTitle(mine ? "My contributions" : "Review queue");
  const project = useProject();
  const session = useSession();
  const toast = useToast();
  const [language, setLanguage] = useState("");
  const [file, setFile] = useState("");
  const [author, setAuthor] = useState("");
  const [status, setStatus] = useState<SuggestionInfo["status"] | "all">(mine ? "all" : "pending");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<number[]>([]);
  const [comment, setComment] = useState("");
  const [failures, setFailures] = useState<ReviewResult["failed"]>([]);
  const debouncedAuthor = useDebounced(author, 250);
  const query = useQuery(
    ["suggestions", mine, language, file, debouncedAuthor, status, cursor],
    ({ fresh }) =>
      listSuggestions(
        {
          language: language || undefined,
          file: file || undefined,
          author: mine ? "me" : debouncedAuthor || undefined,
          status,
          cursor,
          limit: 50,
        },
        { fresh },
      ),
  );
  const fileLanguage = language || project.data?.languages[0]?.tag;
  const files = useQuery(fileLanguage ? ["files", fileLanguage] : null, ({ fresh }) =>
    listFiles(fileLanguage!, { fresh }),
  );
  const mutation = useMutation(review, {
    invalidate: [["suggestions"], ["strings"], ["string"], ["history"], ["project"], ["activity"]],
    onSuccess: (result) => {
      setFailures(result.failed);
      setSelected(result.failed.map((failure) => failure.id));
      toast.show(
        `${result.approved.length} approved, ${result.rejected.length} rejected${
          result.failed.length ? `, ${result.failed.length} need attention` : ""
        }.`,
      );
      document.getElementById("review-heading")?.focus();
    },
  });
  const withdraw = useMutation(withdrawSuggestion, {
    invalidate: [["suggestions"], ["string"], ["project"]],
  });
  const reset = () => {
    setCursor(undefined);
    setSelected([]);
    setFailures([]);
  };
  const items = query.data?.suggestions ?? [];
  const pending = items.filter((s) => s.status === "pending" && session.can("review", s.language));
  const chosen = selected.filter((id) => pending.some((s) => s.id === id));
  const run = (action: "approve" | "reject", ids: number[]) =>
    mutation.run({ ids, action, comment: comment || undefined });
  return (
    <div className="page management-page">
      <div className="page-head">
        <H1 id="review-heading" tabIndex={-1}>
          {mine ? "My contributions" : "Review queue"}
        </H1>
        <span className="muted">{query.data?.total ?? 0} suggestions</span>
      </div>
      <div className="management-filters">
        <SelectField
          label="Language"
          value={language}
          onChange={(v) => {
            setLanguage(v);
            reset();
          }}
        >
          <option value="">All languages</option>
          {project.data?.languages.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="File"
          value={file}
          onChange={(v) => {
            setFile(v);
            reset();
          }}
        >
          <option value="">All files</option>
          {files.data?.files.map((f) => (
            <option key={f.id}>{f.path}</option>
          ))}
        </SelectField>
        {!mine && (
          <Field
            label="Person (user ID)"
            value={author}
            onChange={(e) => {
              setAuthor(e.target.value);
              reset();
            }}
          />
        )}
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v as typeof status);
            reset();
          }}
        >
          {["pending", "approved", "rejected", "superseded", "withdrawn", "all"].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </SelectField>
      </div>
      {!mine && (
        <section className="management-section">
          <TextField
            label="Review comment (optional)"
            value={comment}
            onChange={setComment}
            maxLength={4000}
            error={fieldError(mutation.error, "comment")}
          />
          <div className="actions">
            <Label className="check-label">
              <Checkbox
                checked={pending.length > 0 && chosen.length === pending.length}
                disabled={!pending.length}
                onChange={(e) => setSelected(e.target.checked ? pending.map((s) => s.id) : [])}
              />
              Select all on this page
            </Label>
            <Button
              variant="primary"
              disabled={!chosen.length}
              busy={mutation.pending}
              onClick={() => run("approve", chosen).catch(() => {})}
            >
              Approve selected ({chosen.length})
            </Button>
            <ConfirmButton
              disabled={!chosen.length || mutation.pending}
              title="Reject selected suggestions?"
              description="The suggestions will be marked rejected. The current translations stay as they are."
              onConfirm={() => run("reject", chosen)}
            >
              Reject selected
            </ConfirmButton>
          </div>
        </section>
      )}
      {query.loading && <Loading label="Loading suggestions…" />}
      {query.error !== undefined && (
        <ErrorMessage error={query.error} onRetry={() => query.refresh()} />
      )}
      {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
      {withdraw.error !== undefined && <ErrorMessage error={withdraw.error} />}
      {query.data && !items.length && (
        <EmptyState title={mine ? "No contributions yet" : "No suggestions match"}>
          <p>
            {mine
              ? "Suggestions you send from the editor appear here."
              : "There is nothing waiting for this review filter."}
          </p>
        </EmptyState>
      )}
      {failures.length > 0 && (
        <div role="alert" className="notice notice-error">
          <ul>
            {failures.map((failure) => (
              <li key={failure.id}>
                Suggestion #{failure.id}: {failure.code} — {failure.message}
                {failure.checks?.map((check, i) => (
                  <p key={i}>{check.message}</p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="record-list">
        {items.map((suggestion) => (
          <li className="record-card" key={suggestion.id}>
            <div className="record-head">
              {!mine &&
                suggestion.status === "pending" &&
                session.can("review", suggestion.language) && (
                  <Label className="check-label">
                    <Checkbox
                      aria-label={`Select ${suggestion.key}`}
                      checked={chosen.includes(suggestion.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, suggestion.id]
                            : selected.filter((id) => id !== suggestion.id),
                        )
                      }
                    />
                  </Label>
                )}
              <H2>
                <Link to={editorHref(suggestion.language, { id: suggestion.stringId })}>
                  {suggestion.key}
                </Link>
              </H2>
              <span className={`status status-${suggestion.status}`}>{suggestion.status}</span>
              {suggestion.kind === "llm" && <strong>LLM proposal</strong>}
            </div>
            <p className="muted">
              {suggestion.file} · {suggestion.language} · {suggestion.author.name} ·{" "}
              {formatDateTime(suggestion.createdAt)}
            </p>
            <Proposal suggestion={suggestion} />
            {suggestion.checks.length > 0 && (
              <ul className="checks">
                {suggestion.checks.map((check, i) => (
                  <li key={i} className={`check check-${check.severity}`}>
                    {check.message}
                  </li>
                ))}
              </ul>
            )}
            {suggestion.comment && <p>Reviewer’s comment: {suggestion.comment}</p>}
            {suggestion.reviewer && <p className="muted">Reviewed by {suggestion.reviewer.name}</p>}
            {suggestion.status === "pending" && (
              <div className="actions">
                {!mine && session.can("review", suggestion.language) && (
                  <>
                    <Button
                      variant="primary"
                      busy={mutation.pending}
                      onClick={() => run("approve", [suggestion.id]).catch(() => {})}
                    >
                      {suggestion.kind === "llm" ? "Accept LLM proposal" : "Approve"}
                    </Button>
                    <ConfirmButton
                      disabled={mutation.pending}
                      title="Reject this suggestion?"
                      description="The proposal will be marked rejected and its author can read your comment."
                      onConfirm={() => run("reject", [suggestion.id])}
                    >
                      Reject
                    </ConfirmButton>
                  </>
                )}
                {mine && (
                  <ConfirmButton
                    title="Withdraw this suggestion?"
                    description="It will no longer be available for a manager to approve."
                    onConfirm={() => withdraw.run(suggestion.id)}
                  >
                    Withdraw
                  </ConfirmButton>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="actions">
        {cursor && <Button onClick={reset}>Back to first page</Button>}
        {query.data?.nextCursor && (
          <Button
            onClick={() => {
              const next = query.data?.nextCursor;
              if (next) setCursor(next);
              setSelected([]);
            }}
          >
            Next page
          </Button>
        )}
      </div>
    </div>
  );
}
