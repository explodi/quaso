// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import type { JobInfo } from "@quaso/core";
import { jobProgress } from "./JobProgress.tsx";
import { completionMessage } from "./JobIndicator.tsx";

const JOB: JobInfo = {
  id: 1,
  status: "done",
  priority: "bulk",
  scope: {},
  createdBy: { type: "system", id: null, name: "System" },
  createdAt: 0,
  startedAt: 0,
  finishedAt: 1,
  progress: { done: 1490, total: 1490, translated: 1488, failed: 2, proposed: 0, skipped: 0 },
  tokens: { input: 0, output: 0, thinking: 0 },
  failures: [],
  error: null,
};

test("multi-job progress counts strings instead of averaging job percentages", () => {
  const progress = jobProgress([
    { progress: { ...JOB.progress, done: 30, total: 60 } },
    { progress: { ...JOB.progress, done: 30, total: 240 } },
  ]);
  expect(progress).toStrictEqual({
    done: 60,
    total: 300,
    percent: 20,
    label: "20 percent, 60 of 300 strings",
  });
  expect(jobProgress([])).toStrictEqual({
    done: 0,
    total: 0,
    percent: 0,
    label: "0 percent, 0 of 0 strings",
  });
});

test("completion messages distinguish outcomes and retain failure reasons", () => {
  expect(completionMessage(JOB)).toBe("Translation finished: 1,488 translated, 2 failed");
  expect(completionMessage({ ...JOB, status: "cancelled" })).toBe("Translation cancelled");
  expect(completionMessage({ ...JOB, status: "failed", error: "Provider unavailable" })).toBe(
    "Translation failed: Provider unavailable",
  );
  expect(completionMessage({ ...JOB, status: "queued" })).toBe(undefined);
});
