// SPDX-License-Identifier: MIT
import { H1, H2, EmptyState, Loading } from "@quaso/design-system";
import type { JobsResult } from "@quaso/core";
import { MeaningCheckButton, QualityJobs } from "../components/QualityChecks.tsx";
import { AutoTranslateButton } from "../components/AutoTranslate.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { activeJob, JobCard } from "../components/JobProgress.tsx";
import { Access } from "../components/Management.tsx";
import { queryCache, useQuery } from "../lib/data.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { listJobs } from "../lib/management-api.ts";

function Jobs() {
  useDocumentTitle("Jobs");
  const cached = queryCache.get<JobsResult>(["jobs"]).data;
  const jobs = useQuery(["jobs"], listJobs, {
    refreshInterval: !cached || cached.jobs.some(activeJob) ? 2000 : undefined,
  });
  const current = jobs.data?.jobs.filter((job) => activeJob(job) || job.status === "paused") ?? [];
  const recent = jobs.data?.jobs.filter((job) => !activeJob(job) && job.status !== "paused") ?? [];
  return (
    <div className="page management-page jobs-page">
      <div className="page-head workspace-heading">
        <div>
          <H1 ui>Jobs</H1>
          <p className="muted">
            Follow your AI translations, from queued work to finished strings.
          </p>
        </div>
        <div className="page-actions">
          <AutoTranslateButton />
          <MeaningCheckButton />
        </div>
      </div>
      <QualityJobs />
      {jobs.loading && <Loading label="Loading jobs…" />}
      {jobs.error !== undefined && (
        <ErrorMessage error={jobs.error} onRetry={() => jobs.refresh()} />
      )}
      {jobs.data?.jobs.length === 0 && (
        <EmptyState title="No translation jobs yet">
          <p>Start an auto-translate job to see its progress here.</p>
        </EmptyState>
      )}
      {current.length > 0 && (
        <section className="workspace-job-section" aria-labelledby="current-jobs-heading">
          <div className="record-head">
            <H2 ui id="current-jobs-heading">
              Current jobs
            </H2>
            <span className="status">{current.length}</span>
          </div>
          <div className="record-list">
            {current.map((job) => (
              <JobCard job={job} key={job.id} />
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section className="workspace-job-section" aria-labelledby="recent-jobs-heading">
          <H2 ui id="recent-jobs-heading">
            Recent jobs
          </H2>
          <div className="record-list">
            {recent.map((job) => (
              <JobCard job={job} key={job.id} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
export function JobsPage() {
  return (
    <Access action="translate">
      <Jobs />
    </Access>
  );
}
