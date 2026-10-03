// SPDX-License-Identifier: MIT
import { H1 } from "../components/Typography.tsx";
import type { JobsResult } from "@quaso/core";
import { AutoTranslateButton } from "../components/AutoTranslate.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { activeJob, JobCard } from "../components/JobProgress.tsx";
import { Access } from "../components/Management.tsx";
import { Loading } from "../components/Spinner.tsx";
import { queryCache, useQuery } from "../lib/data.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { listJobs } from "../lib/management-api.ts";

function Jobs() {
  useDocumentTitle("Jobs");
  const cached = queryCache.get<JobsResult>(["jobs"]).data;
  const jobs = useQuery(["jobs"], listJobs, {
    refreshInterval: !cached || cached.jobs.some(activeJob) ? 2000 : undefined,
  });
  return (
    <div className="page management-page">
      <div className="page-head">
        <H1>Jobs</H1>
        <AutoTranslateButton />
      </div>
      {jobs.loading && <Loading label="Loading jobs…" />}
      {jobs.error !== undefined && (
        <ErrorMessage error={jobs.error} onRetry={() => jobs.refresh()} />
      )}
      {jobs.data?.jobs.length === 0 && (
        <EmptyState title="No translation jobs yet">
          <p>Start an auto-translate job to see its progress here.</p>
        </EmptyState>
      )}
      <div className="record-list">
        {jobs.data?.jobs.map((job) => (
          <JobCard job={job} key={job.id} />
        ))}
      </div>
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
