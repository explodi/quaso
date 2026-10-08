// SPDX-License-Identifier: MIT
/** Follows jobs across page navigation and refreshes the project when they finish. */
import type { JobInfo, JobsResult } from "@quaso/core";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { queryCache, useQuery } from "../lib/data.ts";
import { count } from "../lib/format.ts";
import { getJob, listActiveJobs } from "../lib/management-api.ts";
import { Link } from "../lib/router.tsx";
import { Label, Progress } from "@quaso/design-system";
import { activeJob, jobProgress } from "./JobProgress.tsx";
import { useToast } from "./Toast.tsx";

export function completionMessage(job: JobInfo): string | undefined {
  if (job.status === "done")
    return `Translation finished: ${job.progress.translated.toLocaleString("en")} translated, ${job.progress.failed.toLocaleString("en")} failed`;
  if (job.status === "cancelled") return "Translation cancelled";
  if (job.status === "failed") return `Translation failed: ${job.error ?? "Unknown error"}`;
  if (job.status === "paused") return `Translation paused: ${job.error ?? "Waiting to resume"}`;
}

export function JobIndicator() {
  const toast = useToast();
  const tracked = useRef(new Map<number, JobInfo>());
  const pending = useRef(new Set<number>());
  const announced = useRef(new Set<number>());
  const controller = useRef<AbortController | null>(null);
  const cached = queryCache.get<JobsResult>(["jobs", "active"]).data;
  const jobs = useQuery(["jobs", "active"], listActiveJobs, {
    refreshInterval: cached?.jobs.length || tracked.current.size > 0 ? 2000 : 30_000,
    staleTime: 0,
  });
  useEffect(() => {
    const requests = new AbortController();
    controller.current = requests;
    return () => requests.abort();
  }, []);
  useEffect(() => {
    if (!jobs.data || jobs.error !== undefined) return;
    const requests = controller.current;
    if (!requests || requests.signal.aborted) return;
    const current = new Set(jobs.data.jobs.map((job) => job.id));
    for (const job of jobs.data.jobs) {
      if (!announced.current.has(job.id)) tracked.current.set(job.id, job);
    }
    for (const [id] of tracked.current) {
      if (current.has(id) || pending.current.has(id)) continue;
      pending.current.add(id);
      // An active-list disappearance may be a cancellation, failure or pause, not success.
      getJob(id, { fresh: true, signal: requests.signal })
        .then((job) => {
          if (requests.signal.aborted || activeJob(job)) return;
          const message = completionMessage(job);
          if (!message || announced.current.has(id)) return;
          tracked.current.delete(id);
          if (job.status !== "paused") announced.current.add(id);
          toast.show(message, job.status === "failed" ? "error" : "success", {
            duration: 10_000,
            link: {
              to: `/jobs#job-${id}${job.failures.length ? "-failures" : ""}`,
              label: job.failures.length ? "View failures" : "View job",
            },
          });
          for (const key of ["project", "files", "strings", "string", "jobs", "job"])
            void queryCache.invalidate([key]);
        })
        .catch(() => {
          // Keep tracking it so the next successful poll can retry the final status.
        })
        .finally(() => pending.current.delete(id));
    }
  }, [jobs.data, jobs.error, toast.show]);
  const active = jobs.data?.jobs ?? [];
  if (active.length === 0 || !toast.region) return null;
  const progress = jobProgress(active);
  return createPortal(
    <section className="job-indicator" aria-label="Translation jobs" aria-live="off">
      <p>Translating with the LLM… {progress.percent}%</p>
      <Label className="job-progress-label">
        <span className="sr-only">{progress.label}</span>
        <Progress
          max={Math.max(1, progress.total)}
          value={progress.done}
          aria-valuetext={progress.label}
        />
      </Label>
      <Link to={active.length === 1 ? `/jobs#job-${active[0].id}` : "/jobs"}>
        {active.length === 1 ? "View job" : count(active.length, "job")}
      </Link>
    </section>,
    toast.region,
  );
}
