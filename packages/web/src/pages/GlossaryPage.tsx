// SPDX-License-Identifier: MIT
import {
  EmptyState,
  Label,
  Checkbox,
  H1,
  H2,
  Button,
  Dialog,
  Field,
  Loading,
} from "@quaso/design-system";

/** Public terminology, with edits limited to the manager's languages. */
import { type GlossaryTerm, languageName } from "@quaso/core";
import { useState } from "react";
import { QualityCheckButton, QualityJobs } from "../components/QualityChecks.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { ConfirmButton, SelectField, TextField } from "../components/Management.tsx";
import { useToast } from "../components/Toast.tsx";
import {
  createGlossaryTerm,
  deleteGlossaryTerm,
  listGlossary,
  updateGlossaryTerm,
} from "../lib/community-api.ts";
import { queryCache, useQuery } from "../lib/data.ts";
import { fieldError } from "../lib/forms.ts";
import { useDebounced, useDocumentTitle, useProject } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";

export function GlossaryPage() {
  useDocumentTitle("Glossary");
  const session = useSession();
  const project = useProject();
  const { query, setQuery } = useRoute();
  const search = useDebounced(query.q ?? "", 200);
  const glossary = useQuery(["glossary", query.language ?? "", search], (options) =>
    listGlossary({ language: query.language || undefined, q: search || undefined }, options),
  );
  const [editing, setEditing] = useState<GlossaryTerm | "new" | null>(null);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  const mayEdit = (term: GlossaryTerm) =>
    session.can("glossary", term.language ?? undefined) &&
    (term.language !== null ||
      session.user?.role === "administrator" ||
      session.user?.languages === null);
  const changed = async () => {
    await Promise.all([
      queryCache.invalidate(["glossary"]),
      queryCache.invalidate(["string"]),
      queryCache.invalidate(["strings"]),
    ]);
  };
  return (
    <div className="page glossary-page">
      <div className="page-head workspace-heading">
        <QualityCheckButton kind="terminology" language={query.language || undefined} />
        <div>
          <H1 ui>Glossary</H1>
          <p className="muted">The words your team agrees on, in every language.</p>
        </div>
        {session.can("glossary") && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            Add term
          </Button>
        )}
      </div>
      <div className="community-filters">
        <Field
          label="Search glossary"
          type="search"
          value={query.q ?? ""}
          onChange={(e) => setQuery({ q: e.target.value || undefined })}
          placeholder="Term, translation or note"
        />
        <SelectField
          label="Language"
          value={query.language ?? ""}
          onChange={(value) => setQuery({ language: value || undefined })}
        >
          <option value="">All languages</option>
          {project.data?.languages.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.name}
            </option>
          ))}
        </SelectField>
      </div>
      {session.can("translate") && <QualityJobs />}
      {error !== undefined && <ErrorMessage error={error} />}
      {glossary.error !== undefined && (
        <ErrorMessage error={glossary.error} onRetry={() => glossary.refresh()} />
      )}
      {glossary.loading && <Loading label="Loading glossary…" />}
      {glossary.data && (
        <p className="muted" role="status">
          {glossary.data.terms.length} glossary{" "}
          {glossary.data.terms.length === 1 ? "term" : "terms"}
        </p>
      )}
      {glossary.data?.terms.length === 0 && (
        <EmptyState
          title={
            search || query.language ? "No matching terms" : "Start with the words that matter"
          }
        >
          <p>
            {search || query.language
              ? "Try another search or language to find the term you need."
              : "Add product names and preferred translations so people and the AI translator use the same vocabulary."}
          </p>
          {search || query.language ? (
            <Button onClick={() => setQuery({ q: undefined, language: undefined })}>
              Clear filters
            </Button>
          ) : (
            session.can("glossary") && (
              <Button variant="primary" onClick={() => setEditing("new")}>
                Add your first term
              </Button>
            )
          )}
        </EmptyState>
      )}
      <ul className="community-records glossary-list">
        {glossary.data?.terms.map((term) => (
          <li className="card community-record" key={term.id}>
            <div className="glossary-term-name">
              <H2 ui>{term.term}</H2>
              <span className="muted">
                {term.language ? languageName(term.language) : "All languages"}
              </span>
            </div>
            <div className="glossary-term-meaning">
              <p className="glossary-term-label">
                {term.kind === "keep" ? "Keep as written" : "Preferred translation"}
              </p>
              <p className="glossary-term-value" lang={term.language ?? undefined} dir="auto">
                <strong>{term.kind === "keep" ? "Never translate" : term.translation}</strong>
                {term.caseSensitive && <span className="muted"> · Case sensitive</span>}
              </p>
              {term.note && <p className="community-text">{term.note}</p>}
            </div>
            {mayEdit(term) && (
              <div className="actions">
                <Button size="small" onClick={() => setEditing(term)}>
                  Edit term
                </Button>
                <ConfirmButton
                  title={`Delete “${term.term}”?`}
                  description="This removes the term from the glossary, editor hints and AI translation context."
                  onConfirm={async () => {
                    setError(undefined);
                    try {
                      await deleteGlossaryTerm(term.id);
                      await changed();
                      toast.show("Glossary term deleted.");
                    } catch (caught) {
                      setError(caught);
                      throw caught;
                    }
                  }}
                >
                  Delete term
                </ConfirmButton>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing !== null && (
        <TermDialog
          key={editing === "new" ? "new" : editing.id}
          term={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </div>
  );
}

function TermDialog({
  term,
  onClose,
  onSaved,
}: {
  term: GlossaryTerm | null;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const session = useSession();
  const project = useProject();
  const languages = project.data?.languages.filter((l) => session.can("glossary", l.tag)) ?? [];
  const all = session.user?.role === "administrator" || session.user?.languages === null;
  const [text, setText] = useState(term?.term ?? "");
  const [language, setLanguage] = useState(
    term?.language ?? (all ? "" : (languages[0]?.tag ?? "")),
  );
  const [kind, setKind] = useState<"translate" | "keep">(term?.kind ?? "translate");
  const [translation, setTranslation] = useState(term?.translation ?? "");
  const [note, setNote] = useState(term?.note ?? "");
  const [caseSensitive, setCaseSensitive] = useState(term?.caseSensitive ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  return (
    <Dialog
      open
      title={term ? "Edit glossary term" : "Add glossary term"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const body = {
              term: text.trim(),
              language: language || null,
              kind,
              translation: kind === "translate" ? translation.trim() : null,
              caseSensitive,
              note,
            };
            if (term) await updateGlossaryTerm(term.id, body);
            else await createGlossaryTerm(body);
            await onSaved();
            toast.show("Glossary term saved.");
            onClose();
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error !== undefined && <ErrorMessage error={error} />}
        <Field
          label="English term"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
          required
          data-autofocus
          error={fieldError(error, "term")}
        />
        <SelectField
          label="Term language"
          value={language}
          onChange={setLanguage}
          error={fieldError(error, "language")}
        >
          {all && <option value="">All languages</option>}
          {languages.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.name}
            </option>
          ))}
          {language && !languages.some((l) => l.tag === language) && (
            <option value={language}>{languageName(language)}</option>
          )}
        </SelectField>
        <SelectField
          label="How to use this term"
          value={kind}
          onChange={(v) => setKind(v as "translate" | "keep")}
        >
          <option value="translate">Use a translation</option>
          <option value="keep">Never translate</option>
        </SelectField>
        {kind === "translate" && (
          <Field
            label="Translation"
            value={translation}
            onChange={(e) => setTranslation(e.target.value)}
            required
            maxLength={500}
            error={fieldError(error, "translation")}
          />
        )}
        <Label className="check-label">
          <Checkbox checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Match English case exactly
        </Label>
        <TextField label="Note (optional)" value={note} onChange={setNote} maxLength={2000} />
        <div className="actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!all && !language}>
            Save term
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
