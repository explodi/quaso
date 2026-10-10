// SPDX-License-Identifier: MIT
import type { SourceFilesResult } from "@quaso/core";
import { useEffect, useMemo, useRef } from "react";
import { H1, H2, Input, Label, Select, EmptyState, Loading } from "@quaso/design-system";
import { ButtonLink } from "../components/Button.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { FileTree } from "../components/FileTree.tsx";
import { listSources } from "../lib/api.ts";
import { useQuery } from "../lib/data.ts";
import { count, formatNumber } from "../lib/format.ts";
import {
  preferredLanguage,
  useDocumentTitle,
  useProject,
  useRememberLanguage,
} from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";
import { useRoute } from "../lib/router.tsx";
import { buildTree, filterTree, leaves } from "../lib/tree.ts";
import { editorHref } from "./LanguagePage.tsx";

export function SourcesPage() {
  useDocumentTitle("Sources");
  const { query, setQuery, navigate } = useRoute();
  const session = useSession();
  const project = useProject(30_000);
  const sources = useQuery<SourceFilesResult>(["sources"], () => listSources({ fresh: true }), {
    refreshInterval: 30_000,
    staleTime: 0,
  });
  const tree = useMemo(() => buildTree(sources.data?.files ?? []), [sources.data]);
  const shown = useMemo(() => filterTree(tree, query.filter ?? "", false), [tree, query.filter]);
  const languages = project.data?.languages ?? [];
  const language =
    languages.find((entry) => entry.tag === query.language)?.tag ??
    preferredLanguage(languages.map((entry) => entry.tag));
  useRememberLanguage(language);
  const totals = sources.data?.files.reduce(
    (sum, file) => ({ strings: sum.strings + file.strings, words: sum.words + file.words }),
    { strings: 0, words: 0 },
  );
  const revision = project.data?.revision;
  const refresh = sources.refresh;
  const seenRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (revision === undefined) return;
    if (seenRevision.current !== undefined && seenRevision.current !== revision)
      refresh().catch(() => {});
    seenRevision.current = revision;
  }, [revision, refresh]);

  return (
    <div className="page sources-page">
      <div className="page-head workspace-heading">
        <div>
          <H1 ui>Sources</H1>
          <p className="muted">The source of truth for everything your team translates.</p>
        </div>
        {language && (
          <Label className="field source-language-choice">
            Open files in
            <Select
              value={language}
              onChange={(event) => setQuery({ language: event.target.value })}
            >
              {languages.map((entry) => (
                <option key={entry.tag} value={entry.tag}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Label>
        )}
      </div>
      {sources.data && totals && (
        <dl className="workspace-metrics">
          <div>
            <dt>Source files</dt>
            <dd>{formatNumber(sources.data.files.length)}</dd>
          </div>
          <div>
            <dt>Strings</dt>
            <dd>{formatNumber(totals.strings)}</dd>
          </div>
          <div>
            <dt>Source words</dt>
            <dd>{formatNumber(totals.words)}</dd>
          </div>
        </dl>
      )}
      {language && sources.data?.ambiguities && sources.data.ambiguities.length > 0 && (
        <section className="record-card">
          <H2>Needs a description</H2>
          <p>
            The model found ambiguous source wording. Add context in the repository descriptions or
            the editor.
          </p>
          <ul>
            {sources.data.ambiguities.map((note) => (
              <li key={note.id}>
                <ButtonLink to={editorHref(language, { id: note.id, file: note.file })}>
                  {note.file} › {note.key}
                </ButtonLink>
                : {note.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {project.data && !language && (
        <div className="notice notice-info source-language-notice">
          <p>Add a target language to open files in the editor.</p>
          {session.can("settings") && (
            <ButtonLink to="/settings?section=languages">Add a language</ButtonLink>
          )}
        </div>
      )}
      {project.error !== undefined && !project.data && (
        <ErrorMessage error={project.error} onRetry={() => project.refresh()} />
      )}
      <section className="card" aria-labelledby="source-files-heading">
        <div className="card-head">
          <H2 ui id="source-files-heading">
            Repository files
          </H2>
          <Label>
            <span className="sr-only">Filter source files</span>
            <Input
              type="search"
              placeholder="Filter files"
              value={query.filter ?? ""}
              onChange={(event) => setQuery({ filter: event.target.value || undefined })}
            />
          </Label>
        </div>
        {sources.error !== undefined && (
          <ErrorMessage error={sources.error} onRetry={() => sources.refresh()} />
        )}
        {sources.loading && <Loading label="Loading source files…" />}
        {sources.data && (
          <>
            <p className="sr-only" role="status">
              {count(leaves(shown).length, "file")} shown.
            </p>
            {sources.data.files.length === 0 ? (
              <EmptyState title="No source files yet">
                <p>
                  Run <code>npx quaso upload</code> in your repository. Files and their strings will
                  appear here after the first upload.
                </p>
              </EmptyState>
            ) : shown.length === 0 ? (
              <EmptyState title="No file matches the filter">
                <p>Try a filename or a different part of the path.</p>
              </EmptyState>
            ) : (
              <FileTree
                nodes={shown}
                label="Source files"
                columns="counts"
                hrefFor={language ? (file) => editorHref(language, { file }) : undefined}
                onOpen={(file) => {
                  if (language) navigate(editorHref(language, { file }));
                }}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
