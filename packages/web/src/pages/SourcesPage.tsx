// SPDX-License-Identifier: MIT
import type { SourceFilesResult } from "@quaso/core";
import { useEffect, useMemo, useRef } from "react";
import { H1, H2, Input, Label, EmptyState, Loading } from "@quaso/design-system";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { FileTree } from "../components/FileTree.tsx";
import { listSources } from "../lib/api.ts";
import { useQuery } from "../lib/data.ts";
import { count } from "../lib/format.ts";
import { preferredLanguage, useDocumentTitle, useProject } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";
import { buildTree, filterTree, leaves } from "../lib/tree.ts";
import { editorHref } from "./LanguagePage.tsx";

export function SourcesPage() {
  useDocumentTitle("Sources");
  const { query, setQuery, navigate } = useRoute();
  const project = useProject(30_000);
  const sources = useQuery<SourceFilesResult>(["sources"], () => listSources({ fresh: true }), {
    refreshInterval: 30_000,
    staleTime: 0,
  });
  const tree = useMemo(() => buildTree(sources.data?.files ?? []), [sources.data]);
  const shown = useMemo(() => filterTree(tree, query.filter ?? "", false), [tree, query.filter]);
  const language = preferredLanguage(project.data?.languages.map((entry) => entry.tag) ?? []);
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
      <div className="page-head">
        <H1>Sources</H1>
      </div>
      <p className="muted">
        Source files in your repository, with their string and word counts and last upload change.
      </p>
      {project.data && !language && (
        <p className="muted">Add a target language to open files in the editor.</p>
      )}
      {project.error !== undefined && !project.data && (
        <ErrorMessage error={project.error} onRetry={() => project.refresh()} />
      )}
      <section className="card" aria-labelledby="source-files-heading">
        <div className="card-head">
          <H2 id="source-files-heading">Files</H2>
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
                <p>Upload your source files with the CLI.</p>
              </EmptyState>
            ) : shown.length === 0 ? (
              <EmptyState title="No file matches the filter" />
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
