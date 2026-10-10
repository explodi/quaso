// SPDX-License-Identifier: MIT
import {
  Label,
  Input,
  Select,
  H1,
  H2,
  EmptyState,
  Notice,
  ClockIcon,
  HourglassIcon,
  InfoIcon,
  SearchIcon,
  UploadIcon,
  WarningIcon,
  Loading,
  QuasoMascot,
  PixelPattern,
  ChevronRightIcon,
  Details as Disclosure,
  Summary,
} from "@quaso/design-system";
import type { LanguageProgress, ProjectInfo } from "@quaso/core";
import { useMemo, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
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
import { ButtonLink } from "../components/Button.tsx";
import { preferredLanguage } from "../lib/hooks.ts";
import { editorHref } from "./LanguagePage.tsx";

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
  useDocumentTitle("Overview");

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
  const allLanguages = data?.languages ?? [];
  const editableLanguages = allLanguages.filter((language) => session.can("suggest", language.tag));
  const resumeLanguages = editableLanguages.length > 0 ? editableLanguages : allLanguages;
  const preferred = preferredLanguage(resumeLanguages.map((language) => language.tag));
  const resume = data?.languages.find((language) => language.tag === preferred);
  return (
    <div className="page dashboard">
      <div className="page-head">
        <div>
          <H1 ui>Overview</H1>
          <p className="page-intro">
            {data?.name ?? "Your project"} · A little progress, in every language.
          </p>
        </div>
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
        <>
          {resume && (
            <section className="workspace-start" aria-labelledby="start-heading">
              <div className="workspace-start-content">
                <p className="workspace-eyebrow">Your translation workspace</p>
                <H2 ui id="start-heading">
                  Continue translating
                </H2>
                <p>
                  {resume.name} has {count(resume.untranslated, "untranslated string")} and{" "}
                  {count(resume.green, "string")} ready to proofread.
                </p>
                <div className="page-actions">
                  <ButtonLink
                    variant="primary"
                    className="workspace-resume"
                    to={editorHref(resume.tag)}
                  >
                    Continue in {resume.name} <ChevronRightIcon />
                  </ButtonLink>
                  <Link to={fillPattern("/languages/:lang", { lang: resume.tag })}>
                    Browse files
                  </Link>
                </div>
              </div>
              <div className="workspace-start-art" aria-hidden="true">
                <PixelPattern tone="mint" />
                <QuasoMascot decorative />
              </div>
            </section>
          )}
          <dl className="workspace-metrics" aria-label="Project at a glance">
            <div>
              <dt>Languages</dt>
              <dd>{formatNumber(data.languages.length)}</dd>
            </div>
            <div>
              <dt>Source strings</dt>
              <dd>{formatNumber(data.details.strings)}</dd>
            </div>
            <div>
              <dt>To translate</dt>
              <dd>
                {formatNumber(
                  data.languages.reduce((total, language) => total + language.untranslated, 0),
                )}
              </dd>
            </div>
            <div>
              <dt>To proofread</dt>
              <dd>
                {formatNumber(
                  data.languages.reduce((total, language) => total + language.green, 0),
                )}
              </dd>
            </div>
          </dl>
          <section className="card languages-card" aria-labelledby="languages-heading">
            <div className="card-head">
              <div>
                <H2 ui id="languages-heading">
                  Your languages
                </H2>
                <p className="muted">Open a workspace or choose a language to explore its files.</p>
              </div>
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
            <ul className="legend language-legend" aria-label="Translation progress legend">
              <li>
                <span className="legend-swatch legend-blue" aria-hidden="true" />
                Proofread
              </li>
              <li>
                <span className="legend-swatch legend-green" aria-hidden="true" />
                Translated, needs proofreading
              </li>
              <li>
                <span className="legend-swatch legend-rest" aria-hidden="true" />
                Untranslated
              </li>
            </ul>
          </section>
          <ProjectDetails project={data} />
          {data.languageRequestsEnabled && <LanguageRequests />}
        </>
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
      <ButtonLink
        className="language-open"
        size="small"
        to={editorHref(language.tag)}
        aria-label={`Open ${language.name} editor`}
      >
        Open editor <ChevronRightIcon />
      </ButtonLink>
    </li>
  );
}

/** The description as plain text with its line breaks: links stay text (design §8). */
function Description({ text }: { text: string }) {
  if (text.trim() === "") return null;
  return <p className="description">{text}</p>;
}

function ProjectDetails({ project }: { project: ProjectInfo }) {
  const { details } = project;
  return (
    <Disclosure className="card project-details">
      <Summary>About {project.name}</Summary>
      <div className="details-card">
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
      </div>
    </Disclosure>
  );
}
