// SPDX-License-Identifier: MIT
import { Label, Input, Select } from "../components/Controls.tsx";
import { H1, H2 } from "../components/Typography.tsx";
/**
 * The dashboard, the home page (design §5.9, S7.3): every language with its progress bar,
 * "translated % • proofread %" and the words left, with search and sort; the project's
 * description and details.
 */
import type { LanguageProgress, ProjectInfo } from "@quaso/core";
import { useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { ErrorMessage, Notice } from "../components/ErrorMessage.tsx";
import {
  ClockIcon,
  HourglassIcon,
  InfoIcon,
  SearchIcon,
  UploadIcon,
  WarningIcon,
} from "../components/Icons.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Loading } from "../components/Spinner.tsx";
import {
  count,
  formatDateTime,
  formatNumber,
  formatRelative,
  progressText,
  wordsLeftText,
} from "../lib/format.ts";
import { useDocumentTitle, useProject } from "../lib/hooks.ts";
import { fillPattern, Link, useRoute } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { LanguageRequests } from "../components/LanguageRequests.tsx";
import { AutoTranslateButton } from "../components/AutoTranslate.tsx";

const SORTS = {
  name: "Name",
  most: "Most translated",
  least: "Least translated",
} as const;
type Sort = keyof typeof SORTS;

function sortLanguages(languages: LanguageProgress[], sort: Sort): LanguageProgress[] {
  const byName = (a: LanguageProgress, b: LanguageProgress) => a.name.localeCompare(b.name, "en");
  const byProgress = (a: LanguageProgress, b: LanguageProgress) =>
    a.translatedPercent - b.translatedPercent || a.proofreadPercent - b.proofreadPercent;
  const sorted = [...languages];
  if (sort === "name") sorted.sort(byName);
  else if (sort === "most") sorted.sort((a, b) => byProgress(b, a) || byName(a, b));
  else sorted.sort((a, b) => byProgress(a, b) || byName(a, b));
  return sorted;
}

export function Dashboard() {
  const project = useProject(30_000);
  const session = useSession();
  const { query, setQuery } = useRoute();
  const [search, setSearch] = useState(query.q ?? "");
  const sort: Sort = Object.hasOwn(SORTS, query.sort ?? "") ? (query.sort as Sort) : "name";
  useDocumentTitle("Dashboard");

  const languages = useMemo(() => {
    const all = project.data?.languages ?? [];
    const needle = search.trim().toLowerCase();
    const matching =
      needle === ""
        ? all
        : all.filter(
            (l) => l.name.toLowerCase().includes(needle) || l.tag.toLowerCase().includes(needle),
          );
    return sortLanguages(matching, sort);
  }, [project.data, search, sort]);

  const data = project.data;
  return (
    <div className="page dashboard">
      <div className="page-head">
        <H1>{data?.name ?? "Dashboard"}</H1>
        <AutoTranslateButton />
      </div>
      {session.info.setupRequired && (
        <Notice kind="warning" title="This instance isn't set up yet" icon={<InfoIcon />}>
          <p>
            Open /setup and enter the setup key from the deployment configuration to create the
            first administrator.
          </p>
        </Notice>
      )}
      {project.error !== undefined && !data && (
        <ErrorMessage
          error={project.error}
          title="The project couldn't be loaded"
          onRetry={() => project.refresh()}
        />
      )}
      {!data && project.error === undefined && <Loading label="Loading the project…" />}
      {data && (
        <div className="dashboard-grid">
          <section className="card languages-card" aria-labelledby="languages-heading">
            <div className="card-head">
              <H2 id="languages-heading">Languages</H2>
              <div className="toolbar">
                <div className="search">
                  <SearchIcon className="search-icon" />
                  <Label htmlFor="language-search" className="sr-only">
                    Search languages
                  </Label>
                  <Input
                    id="language-search"
                    className="search-input"
                    type="search"
                    placeholder="Search languages"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setQuery({ q: event.target.value || undefined });
                    }}
                  />
                </div>
                <Label className="inline-field">
                  <span>Sort by</span>
                  <Select
                    value={sort}
                    onChange={(event) =>
                      setQuery({
                        sort: event.target.value === "name" ? undefined : event.target.value,
                      })
                    }
                  >
                    {Object.entries(SORTS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Label>
              </div>
            </div>
            {
              // The search's result, announced as it changes (WCAG 4.1.3).
              data.languages.length > 0 && (
                <p className="sr-only" role="status">
                  {search.trim() === ""
                    ? count(data.languages.length, "language")
                    : languages.length === 0
                      ? `No language matches “${search}”.`
                      : `${formatNumber(languages.length)} of ${count(
                          data.languages.length,
                          "language",
                        )} match “${search}”.`}
                </p>
              )
            }
            {data.languages.length === 0 ? (
              <EmptyState icon={<UploadIcon size={24} />} title="No languages yet">
                <p>
                  Languages appear when the team uploads the {data.sourceLanguageName} files with
                  the CLI: <code>quaso upload</code>.
                </p>
              </EmptyState>
            ) : languages.length === 0 ? (
              <p className="muted pad" aria-hidden="true">
                No language matches “{search}”.
              </p>
            ) : (
              <ul className="language-list" aria-label="Languages">
                {languages.map((language) => (
                  <LanguageRow key={language.tag} language={language} />
                ))}
              </ul>
            )}
          </section>
          <Details project={data} />
          {data.languageRequestsEnabled && <LanguageRequests />}
        </div>
      )}
    </div>
  );
}

function LanguageRow({ language }: { language: LanguageProgress }) {
  return (
    <li className="language-row">
      <Link to={fillPattern("/languages/:lang", { lang: language.tag })} className="language-link">
        <span className="language-name">
          {language.name}
          <span className="language-tag">{language.tag}</span>
        </span>
        <ProgressBar progress={language} />
        <span className="language-stats">
          <span>{progressText(language)}</span>
          <span className="muted">{wordsLeftText(language)}</span>
        </span>
        <span className="language-flags">
          {language.outdated > 0 && (
            <span className="flag">
              <ClockIcon className="flag-outdated" /> {count(language.outdated, "outdated string")}
            </span>
          )}
          {language.pending > 0 && (
            <span className="flag">
              <HourglassIcon className="flag-pending" /> {formatNumber(language.pending)} pending
            </span>
          )}
          {language.qa > 0 && (
            <span className="flag">
              <WarningIcon className="flag-qa" /> {count(language.qa, "QA problem")}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

/** The description as plain text with its line breaks: links stay text (design §8). */
function Description({ text }: { text: string }) {
  if (text.trim() === "") return null;
  return <p className="description">{text}</p>;
}

function Details({ project }: { project: ProjectInfo }) {
  const { details } = project;
  return (
    <aside className="card details-card" aria-labelledby="details-heading">
      <H2 id="details-heading">About this project</H2>
      <Description text={project.description} />
      <dl className="details">
        <div>
          <dt>Source language</dt>
          <dd>{project.sourceLanguageName}</dd>
        </div>
        <div>
          <dt>Strings</dt>
          <dd>{formatNumber(details.strings)}</dd>
        </div>
        <div>
          <dt>Words</dt>
          <dd>{formatNumber(details.words)}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{formatNumber(details.files)}</dd>
        </div>
        <div>
          <dt>Languages</dt>
          <dd>{formatNumber(project.languages.length)}</dd>
        </div>
        <div>
          <dt>Members</dt>
          <dd>{formatNumber(details.members)}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>
            {details.lastActivity === null ? (
              "None yet"
            ) : (
              <time
                dateTime={new Date(details.lastActivity).toISOString()}
                title={formatDateTime(details.lastActivity)}
              >
                {formatRelative(details.lastActivity)}
              </time>
            )}
          </dd>
        </div>
      </dl>
      <p className="legend-intro">What the colours mean:</p>
      <ul className="legend">
        <li>
          <span className="legend-swatch legend-blue" aria-hidden="true" /> Blue: proofread by a
          person
        </li>
        <li>
          <span className="legend-swatch legend-green" aria-hidden="true" /> Green: translated by
          the LLM, not yet proofread
        </li>
        <li>
          <span className="legend-swatch legend-rest" aria-hidden="true" /> Grey: untranslated
        </li>
      </ul>
    </aside>
  );
}
