// SPDX-License-Identifier: MIT
import { Label, Progress, Details, Summary, H2, Loading } from "@quaso/design-system";

/** Job progress is shared by the queue, the auto-translate dialog and the editor. */
import type { JobInfo } from "@quaso/core";
import { useEffect, useRef } from "react";
import { queryCache, useMutation, useQuery } from "../lib/data.ts";
import { cancelJob, getJob } from "../lib/management-api.ts";
import { Link } from "../lib/router.tsx";
import { useRoute } from "../lib/router.tsx";
import { formatNumber } from "../lib/format.ts";
import { editorHref } from "../pages/LanguagePage.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { ConfirmButton } from "./Management.tsx";

export function activeJob(job: JobInfo): boolean {
  return job.status === "queued" || job.status === "running";
}

export function jobProgress(jobs: readonly Pick<JobInfo, "progress">[]) {
  let done = 0;
  let total = 0;
  for (const job of jobs) {
    done += job.progress.done;
    total += job.progress.total;
  }
  const percent = total === 0 ? 0 : Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
  return {
    done,
    total,
    percent,
    label: `${percent} percent, ${formatNumber(done)} of ${formatNumber(total)} strings`,
  };
}

export function JobCard({ job }: { job: JobInfo }) {
  const progress = jobProgress([job]);
  const { location } = useRoute();
  const cancel = useMutation(cancelJob, { invalidate: [["jobs"], ["job"]] });
  return (
    <article id={`job-${job.id}`} className="record-card job-card">
      <div className="record-head">
        <H2>Job #{job.id}</H2>
        <span className={`status status-${job.status}`}>{job.status}</span>
        <span className="muted">{job.priority} priority</span>
      </div>
      <Label className="job-progress-label">
        <span aria-hidden="true">
          {progress.percent}% · {job.progress.done} / {job.progress.total} done
        </span>
        <span className="sr-only">{progress.label}</span>
        <Progress
          max={Math.max(1, job.progress.total)}
          value={job.progress.done}
          aria-valuetext={progress.label}
        />
      </Label>
      <p>
        {job.progress.translated} translated · {job.progress.proposed} proposed ·{" "}
        {job.progress.reused ? `${job.progress.reused} reused · ` : ""}
        {job.progress.failed} failed · {job.progress.skipped} skipped
      </p>
      {job.outdatedLeft !== undefined && job.outdatedLeft > 0 && (
        <p>{job.outdatedLeft} outdated translations left as they were.</p>
      )}
      <p className="muted">
        Tokens: {job.tokens.input} input · {job.tokens.output} output · {job.tokens.thinking}{" "}
        thinking
      </p>
      {job.error && <p className="field-error">{job.error}</p>}
      {job.failures.length > 0 && (
        <Details id={`job-${job.id}-failures`} open={location.hash === `#job-${job.id}-failures`}>
          <Summary>{job.failures.length} failures</Summary>
          <ul>
            {job.failures.map((failure, index) => (
              <li key={index}>
                <Link
                  to={editorHref(failure.language, { id: failure.stringId, file: failure.file })}
                >
                  {failure.file} · {failure.key} · {failure.language}
                </Link>
                : {failure.reason}
              </li>
            ))}
          </ul>
        </Details>
      )}
      {(activeJob(job) || job.status === "paused") && (
        <ConfirmButton
          title={`Cancel job #${job.id}?`}
          description="Work already completed stays. Strings that have not been processed will stay as they are."
          disabled={cancel.pending}
          onConfirm={() => cancel.run(job.id)}
        >
          Cancel job
        </ConfirmButton>
      )}
      {cancel.error !== undefined && <ErrorMessage error={cancel.error} />}
    </article>
  );
}

export function JobProgress({ id, onDone }: { id: number; onDone?(): void }) {
  const completed = useRef<number | null>(null);
  const callback = useRef(onDone);
  callback.current = onDone;
  const cached = queryCache.get<JobInfo>(["job", id]).data;
  const job = useQuery(["job", id], (options) => getJob(id, options), {
    refreshInterval: cached && !activeJob(cached) ? undefined : 2000,
    staleTime: 0,
  });
  useEffect(() => {
    if (!job.data) return;
    if (!activeJob(job.data) && completed.current !== id) {
      completed.current = id;
      callback.current?.();
    }
  }, [id, job.data]);
  return (
    <div aria-live="polite">
      {job.loading && <Loading label="Loading job progress…" />}
      {job.error !== undefined && <ErrorMessage error={job.error} onRetry={() => job.refresh()} />}
      {job.data && <JobCard job={job.data} />}
    </div>
  );
}
