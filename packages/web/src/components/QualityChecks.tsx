// SPDX-License-Identifier: MIT
import { Button, Dialog, H2, Loading, Select, Label, Details, Summary } from "@quaso/design-system";
import type { QualityJobInfo, QualityJobRequest } from "@quaso/core";
import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api.ts";
import { useMutation, useQuery } from "../lib/data.ts";
import { useProject } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";
import { Link } from "../lib/router.tsx";
import { editorHref } from "../pages/LanguagePage.tsx";
import { TerminologyReview, StyleGuideReview } from "./TerminologyReview.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";

export function QualityCheckButton({
  language,
  file,
  strings,
  suggestions,
  onChecked,
  kind = "meaning",
}: {
  language?: string;
  file?: string;
  strings?: number[];
  suggestions?: number[];
  onChecked?(): void;
  kind?: QualityJobRequest["kind"];
}) {
  const session = useSession();
  const project = useProject();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(language ?? "");
  const [jobId, setJobId] = useState<number | null>(null);
  const start = useMutation(
    (body: QualityJobRequest) => request<QualityJobInfo>("/quality-jobs", { method: "POST", body }),
    { invalidate: [["qualityJobs"]] },
  );
  if (!session.can("translate", language)) return null;
  if (kind === "style_guide" && !session.can("settings")) return null;
  const label =
    kind === "meaning"
      ? "Check meaning"
      : kind === "terminology"
        ? "Suggest glossary terms"
        : "Draft style guide";
  const languages =
    project.data?.languages.filter((entry) => session.can("translate", entry.tag)) ?? [];
  return (
    <>
      <Button disabled={!project.data?.llmAvailable} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {jobId !== null && <QualityJobProgress id={jobId} onDone={onChecked} />}
      {open && (
        <Dialog open title={label} onClose={() => setOpen(false)}>
          <form
            className="form"
            onSubmit={async (event) => {
              event.preventDefault();
              const tags = selected ? [selected] : languages.map((entry) => entry.tag);
              try {
                const job = await start.run({
                  kind,
                  languages: tags,
                  files: file ? [file] : undefined,
                  strings,
                  suggestions,
                });
                setJobId(job.id);
                setOpen(false);
              } catch {
                /* The mutation exposes its error below. */
              }
            }}
          >
            <p>
              {kind === "meaning"
                ? "Compare source and translations; findings appear as QA warnings."
                : kind === "terminology"
                  ? "Extract recurring terms and review the existing renderings."
                  : "Draft editable language instructions from proofread translations."}
            </p>
            <Label>
              Language
              <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
                <option value="">All assigned languages</option>
                {languages.map((entry) => (
                  <option key={entry.tag} value={entry.tag}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </Label>
            {file && (
              <p>
                File: <code>{file}</code>
              </p>
            )}
            {start.error !== undefined && <ErrorMessage error={start.error} />}
            <Button
              type="submit"
              variant="primary"
              busy={start.pending}
              disabled={languages.length === 0}
            >
              Start analysis
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}

export function QualityJobCard({ job }: { job: QualityJobInfo }) {
  return (
    <article className="record-card">
      <H2>
        {job.kind === "meaning"
          ? "Meaning check"
          : job.kind === "terminology"
            ? "Terminology report"
            : "Style guide draft"}{" "}
        #{job.id}
      </H2>
      <p>
        {job.status} · {job.done} / {job.total} checked · {job.flagged} warnings
      </p>
      {job.error && <p className="field-error">{job.error}</p>}
      {job.kind === "terminology" && <TerminologyReview job={job} />}
      {job.kind === "style_guide" && <StyleGuideReview drafts={job.result} />}
      {job.kind === "meaning" && job.result.length > 0 && (
        <Details open>
          <Summary>Meaning differences</Summary>
          <ul>
            {job.result.map((finding, index) => (
              <li key={index}>
                <Link to={editorHref(finding.language, { id: finding.id, file: finding.file })}>
                  {finding.file} › {finding.key} · {finding.language}
                </Link>
                <ul>
                  {finding.checks.map((check, note) => (
                    <li key={note}>{check.message}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Details>
      )}
    </article>
  );
}

export function QualityJobProgress({ id, onDone }: { id: number; onDone?(): void }) {
  const job = useQuery(["qualityJob", id], () => request<QualityJobInfo>(`/quality-jobs/${id}`), {
    refreshInterval: 2000,
    staleTime: 0,
  });
  const notified = useRef<number | null>(null);
  const callback = useRef(onDone);
  callback.current = onDone;
  useEffect(() => {
    if (
      !job.data ||
      job.data.status === "queued" ||
      job.data.status === "running" ||
      job.data.status === "paused"
    )
      return;
    if (notified.current === id) return;
    notified.current = id;
    callback.current?.();
  }, [id, job.data]);
  return (
    <div aria-live="polite">
      {job.loading && <Loading label="Checking meaning…" />}
      {job.error !== undefined && <ErrorMessage error={job.error} />}
      {job.data && <QualityJobCard job={job.data} />}
    </div>
  );
}

export function QualityJobs() {
  const jobs = useQuery(
    ["qualityJobs"],
    () => request<{ jobs: QualityJobInfo[] }>("/quality-jobs"),
    { refreshInterval: 2000 },
  );
  return (
    <section>
      <H2>Quality and terminology jobs</H2>
      {jobs.error !== undefined && <ErrorMessage error={jobs.error} />}
      {jobs.data?.jobs.map((job) => (
        <QualityJobCard key={job.id} job={job} />
      ))}
    </section>
  );
}
