// SPDX-License-Identifier: MIT
/** Typed endpoints for the people and job pages. */
import {
  CreateInviteRequest,
  CreateJobRequest,
  DeleteAccountRequest,
  ReviewRequest,
  ReviewVolunteerRequest,
  UpdateAccountRequest,
  UpdateMemberRequest,
  VolunteerRequest,
} from "@quaso/core";
import type {
  InviteInfo,
  JobInfo,
  JobsResult,
  MembersResult,
  ResetLink,
  ReviewResult,
  SuggestionsPage,
  SuggestionsQuery,
  UsageQuery,
  UsageResult,
  UserInfo,
} from "@quaso/core";
import { type ReadOptions, request } from "./api.ts";
import { validated } from "./forms.ts";

export const listSuggestions = (query: SuggestionsQuery, options: ReadOptions = {}) =>
  request<SuggestionsPage>("/suggestions", { query: { ...query }, ...options });
export const review = (body: ReviewRequest) =>
  request<ReviewResult>("/suggestions/review", {
    method: "POST",
    body: validated(ReviewRequest, body),
  });
export const requestVolunteer = (body: VolunteerRequest) =>
  request("/volunteer-requests", { method: "POST", body: validated(VolunteerRequest, body) });
export const listMembers = (options: ReadOptions = {}) =>
  request<MembersResult>("/team/members", options);
export const listVolunteers = (options: ReadOptions = {}) =>
  request<MembersResult>("/team/volunteer-requests", options);
export const updateMember = (id: number, body: UpdateMemberRequest) =>
  request(`/team/members/${id}`, { method: "PATCH", body: validated(UpdateMemberRequest, body) });
export const removeMember = (id: number) => request(`/team/members/${id}`, { method: "DELETE" });
export const resetLink = (id: number) =>
  request<ResetLink>(`/team/members/${id}/reset-link`, { method: "POST" });
export const reviewVolunteer = (id: number, body: ReviewVolunteerRequest) =>
  request(`/team/volunteer-requests/${id}`, {
    method: "POST",
    body: validated(ReviewVolunteerRequest, body),
  });
export const listInvites = (options: ReadOptions = {}) =>
  request<{ invites: InviteInfo[] }>("/team/invites", options);
export const createInvite = (body: CreateInviteRequest) =>
  request<InviteInfo>("/team/invites", {
    method: "POST",
    body: validated(CreateInviteRequest, body),
  });
export const revokeInvite = (id: number) => request(`/team/invites/${id}`, { method: "DELETE" });
export const updateAccount = (body: UpdateAccountRequest) =>
  request<UserInfo>("/account", { method: "PATCH", body: validated(UpdateAccountRequest, body) });
export const deleteAccount = (body: DeleteAccountRequest) =>
  request("/account", { method: "DELETE", body: validated(DeleteAccountRequest, body) });
export const unlinkIdentity = (provider: "github" | "discord") =>
  request(`/account/identities/${provider}`, { method: "DELETE" });
export const listJobs = (options: ReadOptions = {}) => request<JobsResult>("/jobs", options);
export const listActiveJobs = (options: ReadOptions = {}) =>
  request<JobsResult>("/jobs", { query: { active: true }, ...options });
export const getJob = (id: number, options: ReadOptions = {}) =>
  request<JobInfo>(`/jobs/${id}`, options);
export const cancelJob = (id: number) => request(`/jobs/${id}`, { method: "DELETE" });
export const getUsage = (query: UsageQuery, options: ReadOptions = {}) =>
  request<UsageResult>("/usage", { query: { ...query }, ...options });
export const checkJobRequest = (body: CreateJobRequest) => validated(CreateJobRequest, body);
