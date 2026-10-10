// SPDX-License-Identifier: MIT
import {
  Label,
  Input,
  Checkbox,
  H1,
  H2,
  EmptyState,
  ArrowLeftIcon,
  SearchIcon,
  Loading,
  EmptySquareIcon,
  HalfSquareIcon,
  CheckSquareIcon,
  ClockIcon,
  HourglassIcon,
  WarningIcon,
} from "@quaso/design-system";

import type { LanguageFilesResult, LanguageProgress } from "@quaso/core";
import { useMemo, useState } from "react";
import { ButtonLink } from "../components/Button.tsx";
import { AutoTranslateButton } from "../components/AutoTranslate.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { FileTree } from "../components/FileTree.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { listFiles } from "../lib/api.ts";
import { useQuery } from "../lib/data.ts";
import { count, formatNumber, languageLabel, progressText, wordsLeftText } from "../lib/format.ts";
import { outdatedExplanation } from "../lib/states.ts";
import { useDocumentTitle, useProject, useRememberLanguage } from "../lib/hooks.ts";
import { fillPattern, href, Link, useRoute } from "../lib/router.tsx";
import { buildTree, filterTree, leaves } from "../lib/tree.ts";
import { NotFound } from "./NotFound.tsx";

export function editorHref(
  language: string,
  query: Record<string, string | number | undefined> = {},
) {
  return href(fillPattern("/translate/:lang", { lang: language }), query);
}

export function LanguagePage() {
  const { params, query, setQuery, navigate } = useRoute();
  const tag = params.lang;
  const project = useProject(30_000);
  const language = project.data?.languages.find((l) => l.tag.toLowerCase() === tag.toLowerCase());
  const languageTag = language?.tag;
  useRememberLanguage(languageTag);
  const files = useQuery<LanguageFilesResult>(
    languageTag ? ["files", languageTag] : null,
    ({ fresh }) => listFiles(languageTag ?? tag, { fresh }),
    { refreshInterval: 30_000 },
  );
  const [filter, setFilter] = useState(query.filter ?? "");
  const hideCompleted = query.hide === "completed";
  const name = language?.name ?? languageLabel(tag);
  useDocumentTitle(name);

  const tree = useMemo(() => buildTree(files.data?.files ?? []), [files.data]);
  const shown = useMemo(
    () => filterTree(tree, filter, hideCompleted),
    [tree, filter, hideCompleted],
  );

  if (project.data && !language) {
    return (
      <NotFound
        title={`No language “${tag}”`}
        message="This project doesn't translate into that language."
      />
    );
  }

  return (
    <div className="page language-page">
      <p className="breadcrumb">
        <Link to="/">
          <ArrowLeftIcon /> All languages
        </Link>
      </p>
      <div className="page-head">
        <div>
          <H1 ui>
            {name}
            {language && <span className="heading-tag">{language.tag}</span>}
          </H1>
          <p className="page-intro">Choose what needs your attention, or explore by file.</p>
        </div>
        <div className="page-actions">
          {language && <AutoTranslateButton language={language.tag} />}
          {language && (
            <ButtonLink variant="primary" to={editorHref(language.tag)}>
              Translate all
            </ButtonLink>
          )}
        </div>
      </div>
      {project.error !== undefined && !project.data && (
        <ErrorMessage error={project.error} onRetry={() => project.refresh()} />
      )}
      {language && <LanguageSummary language={language} />}
      <section className="card" aria-labelledby="files-heading">
        <div className="card-head">
          <div>
            <H2 ui id="files-heading">
              Explore files
            </H2>
            <p className="muted">Find the right part of the project.</p>
          </div>
          <div className="toolbar">
            <div className="search">
              <SearchIcon className="search-icon" />
              <Label htmlFor="file-filter" className="sr-only">
                Filter files
              </Label>
              <Input
                id="file-filter"
                className="search-input"
                type="search"
                placeholder="Filter files"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setQuery({ filter: event.target.value || undefined });
                }}
              />
            </div>
            <Label className="checkbox">
              <Checkbox
                checked={hideCompleted}
                onChange={(event) =>
                  setQuery({ hide: event.target.checked ? "completed" : undefined })
                }
              />
              Hide completed
            </Label>
          </div>
        </div>
        {files.error !== undefined && !files.data && (
          <ErrorMessage error={files.error} onRetry={() => files.refresh()} />
        )}
        {(files.loading || (!language && !project.error)) && <Loading label="Loading the files…" />}
        {files.data && files.data.files.length === 0 && (
          <EmptyState title="No files yet">
            <p>Files appear when the team uploads them with the CLI.</p>
          </EmptyState>
        )}
        {files.data && files.data.files.length > 0 && (
          // The filter's result, announced as it changes (WCAG 4.1.3).
          <p className="sr-only" role="status">
            {shown.length === 0
              ? hideCompleted && filter === ""
                ? "Every file is complete: translated and up to date."
                : "No file matches the filter."
              : filter === "" && !hideCompleted
                ? count(files.data.files.length, "file")
                : `${formatNumber(leaves(shown).length)} of ${count(
                    files.data.files.length,
                    "file",
                  )} shown.`}
          </p>
        )}
        {files.data && files.data.files.length > 0 && shown.length === 0 && (
          <p className="muted pad" aria-hidden="true">
            {hideCompleted && filter === ""
              ? "Every file is complete: translated and up to date."
              : "No file matches the filter."}
          </p>
        )}
        {language && shown.length > 0 && (
          <FileTree
            key={`${filter}|${hideCompleted}`}
            nodes={shown}
            label={`Files in ${name}`}
            onOpen={(path) => navigate(editorHref(language.tag, { file: path }))}
            hrefFor={(path) => editorHref(language.tag, { file: path })}
          />
        )}
      </section>
    </div>
  );
}

function LanguageSummary({ language }: { language: LanguageProgress }) {
  const sourceLanguageName = useProject().data?.sourceLanguageName ?? "source text";
  return (
    <section className="card summary-card" aria-label="Progress">
      <ProgressBar progress={language} />
      <p className="summary-line">
        <strong>{progressText(language)}</strong>
        <span className="muted">
          {wordsLeftText(language)} · {count(language.strings, "string")} ·{" "}
          {count(language.words, "word")}
        </span>
      </p>
      <ul className="summary-counts">
        <li>
          <Link className="language-task" to={editorHref(language.tag, { state: "untranslated" })}>
            <EmptySquareIcon />
            <strong>{formatNumber(language.untranslated)}</strong>
            <span>Untranslated</span>
          </Link>
        </li>
        <li>
          <Link className="language-task" to={editorHref(language.tag, { state: "green" })}>
            <HalfSquareIcon />
            <strong>{formatNumber(language.green)}</strong>
            <span>Needs proofreading</span>
          </Link>
        </li>
        <li>
          <Link className="language-task" to={editorHref(language.tag, { state: "blue" })}>
            <CheckSquareIcon />
            <strong>{formatNumber(language.blue)}</strong>
            <span>Proofread</span>
          </Link>
        </li>
        {language.outdated > 0 && (
          <li>
            <Link className="language-task" to={editorHref(language.tag, { state: "outdated" })}>
              <ClockIcon />
              <strong>{formatNumber(language.outdated)}</strong>
              <span>Outdated</span>
            </Link>
          </li>
        )}
        {language.pending > 0 && (
          <li>
            <Link className="language-task" to={editorHref(language.tag, { state: "pending" })}>
              <HourglassIcon />
              <strong>{formatNumber(language.pending)}</strong>
              <span>Suggestions pending</span>
            </Link>
          </li>
        )}
        {language.qa > 0 && (
          <li>
            <Link className="language-task" to={editorHref(language.tag, { state: "qa" })}>
              <WarningIcon />
              <strong>{formatNumber(language.qa)}</strong>
              <span>Quality issues</span>
            </Link>
          </li>
        )}
      </ul>
      {language.outdated > 0 && (
        <p className="summary-note muted">
          <ClockIcon />
          <span>
            <strong>Outdated.</strong> {outdatedExplanation(sourceLanguageName, language.outdated)}
          </span>
        </p>
      )}
    </section>
  );
}
