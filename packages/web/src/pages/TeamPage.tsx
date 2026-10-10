// SPDX-License-Identifier: MIT
import {
  H3,
  H1,
  H2,
  Button,
  Loading,
  Details,
  Summary,
  Tabs,
  EmptyState,
} from "@quaso/design-system";
/** Administrators manage roles, language limits, volunteer requests and one-time links. */
import type { CreateInviteRequest, MemberInfo, Role } from "@quaso/core";
import { useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import {
  Access,
  ConfirmButton,
  LanguagePicker,
  OneTimeSecret,
  SelectField,
} from "../components/Management.tsx";
import { useToast } from "../components/Toast.tsx";
import { useMutation, useQuery } from "../lib/data.ts";
import { fieldError } from "../lib/forms.ts";
import { formatDateTime } from "../lib/format.ts";
import { useDocumentTitle } from "../lib/hooks.ts";
import { roleLabel } from "../lib/permissions.ts";
import { useRoute } from "../lib/router.tsx";
import {
  createInvite,
  listInvites,
  listMembers,
  listVolunteers,
  removeMember,
  resetLink,
  reviewVolunteer,
  revokeInvite,
  updateMember,
} from "../lib/management-api.ts";

const TEAM_KEYS = [["team"], ["session"], ["project"]];

function Member({
  member,
  volunteer = false,
  onSecret,
}: {
  member: MemberInfo;
  volunteer?: boolean;
  onSecret(value: string): void;
}) {
  const [role, setRole] = useState<Role>(volunteer ? "contributor" : member.role);
  const [languages, setLanguages] = useState<string[] | null>(
    volunteer ? (member.volunteerRequest?.languages ?? []) : member.languages,
  );
  const toast = useToast();
  const mutation = useMutation(
    async (action: "save" | "remove" | "approve" | "reject" | "reset") => {
      if (action === "save") await updateMember(member.id, { role, languages });
      if (action === "remove") await removeMember(member.id);
      if (action === "approve" || action === "reject") {
        await reviewVolunteer(member.id, {
          approve: action === "approve",
          role: role === "manager" ? "manager" : "contributor",
          languages,
        });
      }
      if (action === "reset") {
        onSecret((await resetLink(member.id)).url);
        return;
      }
      if (action === "remove" || action === "approve" || action === "reject") {
        document.getElementById("team-heading")?.focus();
      }
      toast.show(
        action === "approve"
          ? "Volunteer approved."
          : action === "reject"
            ? "Request rejected."
            : "Team updated.",
      );
    },
    { invalidate: TEAM_KEYS },
  );
  return (
    <li className={`record-card team-member${volunteer ? " team-volunteer" : ""}`}>
      <div className="record-head">
        <H3 ui>{member.displayName}</H3>
        {!volunteer && <span className="status">{roleLabel(member.role)}</span>}
      </div>
      <p className="muted">
        {member.email ?? "No email address"} · User #{member.id} · {member.contributions}{" "}
        contributions
      </p>
      {!volunteer && <p className="muted">{member.languages?.join(", ") ?? "All languages"}</p>}
      {volunteer && <p>{member.volunteerRequest?.message}</p>}
      <Details open={volunteer || undefined} className="member-access">
        <Summary>{volunteer ? "Review volunteer access" : "Manage access"}</Summary>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.run(volunteer ? "approve" : "save").catch(() => {});
          }}
        >
          <SelectField
            label={`Role for ${member.displayName}`}
            value={role}
            onChange={(value) => setRole(value as Role)}
          >
            {(volunteer
              ? ["contributor", "manager"]
              : ["none", "contributor", "manager", "administrator"]
            ).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
          <LanguagePicker
            value={languages}
            allowAll
            onChange={setLanguages}
            label={`Languages for ${member.displayName}`}
            error={fieldError(mutation.error, "languages")}
          />
          <div className="actions">
            <Button type="submit" variant="primary" busy={mutation.pending}>
              {volunteer ? "Approve volunteer" : "Save member"}
            </Button>
            {volunteer ? (
              <ConfirmButton
                title="Reject volunteer request?"
                description="This person will remain signed in without a contributor role."
                disabled={mutation.pending}
                onConfirm={() => mutation.run("reject")}
              >
                Reject request
              </ConfirmButton>
            ) : (
              <>
                <ConfirmButton
                  title="Remove member?"
                  description="Their contributor or manager role will be removed. Their account and existing translations stay."
                  disabled={mutation.pending}
                  onConfirm={() => mutation.run("remove")}
                >
                  Remove member
                </ConfirmButton>
                <Button
                  busy={mutation.pending}
                  onClick={() => mutation.run("reset").catch(() => {})}
                >
                  Create reset link
                </Button>
              </>
            )}
          </div>
          {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
        </form>
      </Details>
    </li>
  );
}

function Team() {
  useDocumentTitle("Team");
  const { query, setQuery } = useRoute();
  const section = query.tab === "invites" ? "invites" : "members";
  const members = useQuery(["team", "members"], listMembers);
  const volunteers = useQuery(["team", "volunteers"], listVolunteers);
  const invites = useQuery(["team", "invites"], listInvites);
  const [secret, setSecret] = useState<string | null>(null);
  const [role, setRole] = useState<CreateInviteRequest["role"]>("contributor");
  const [languages, setLanguages] = useState<string[] | null>(null);
  const create = useMutation(createInvite, {
    invalidate: [["team", "invites"]],
    onSuccess: (invite) => setSecret(invite.url ?? null),
  });
  const revoke = useMutation(revokeInvite, { invalidate: [["team", "invites"]] });
  return (
    <div className="page management-page team-page">
      <div className="page-head workspace-heading">
        <div>
          <H1 ui id="team-heading" tabIndex={-1}>
            Team
          </H1>
          <p className="muted">Bring people in and give them the right languages to work on.</p>
        </div>
        <Button variant="primary" onClick={() => setQuery({ tab: "invites" })}>
          Invite someone
        </Button>
      </div>
      <section className="management-section team-requests">
        <div className="record-head">
          <H2 ui>Volunteer requests</H2>
          {!!volunteers.data?.members.length && (
            <span className="status">{volunteers.data.members.length} waiting</span>
          )}
        </div>
        {volunteers.loading && <Loading label="Loading volunteer requests…" />}
        {volunteers.error !== undefined && (
          <ErrorMessage error={volunteers.error} onRetry={() => volunteers.refresh()} />
        )}
        {volunteers.data?.members.length === 0 && (
          <p className="muted">No volunteer requests are waiting.</p>
        )}
        <ul className="record-list">
          {volunteers.data?.members.map((member) => (
            <Member key={member.id} member={member} volunteer onSecret={setSecret} />
          ))}
        </ul>
      </section>
      <Tabs
        label="Team management"
        selected={section}
        onSelect={(value) => setQuery({ tab: value })}
        tabs={[
          {
            id: "members",
            label: `Members${members.data ? ` (${members.data.members.length})` : ""}`,
          },
          { id: "invites", label: "Invite links" },
        ]}
      >
        {section === "members" && (
          <section className="team-members">
            <H2 ui>Members</H2>
            {members.loading && <Loading label="Loading members…" />}
            {members.error !== undefined && (
              <ErrorMessage error={members.error} onRetry={() => members.refresh()} />
            )}
            {members.data?.members.length === 0 && (
              <EmptyState title="Build your translation team">
                <p>Create an invite link for a contributor, manager or administrator.</p>
                <Button onClick={() => setQuery({ tab: "invites" })}>Create an invite</Button>
              </EmptyState>
            )}
            <ul className="record-list">
              {members.data?.members.map((member) => (
                <Member key={member.id} member={member} onSecret={setSecret} />
              ))}
            </ul>
          </section>
        )}
        {section === "invites" && (
          <section className="management-section">
            <H2 ui>Invite links</H2>
            <p className="muted">Choose their role and languages, then share the one-time link.</p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                create.run({ role, languages }).catch(() => {});
              }}
            >
              <SelectField
                label="Invite role"
                value={role}
                onChange={(value) => setRole(value as typeof role)}
              >
                {["contributor", "manager", "administrator"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </SelectField>
              <LanguagePicker
                value={languages}
                onChange={setLanguages}
                allowAll
                label="Invite languages"
                error={fieldError(create.error, "languages")}
              />
              <p className="muted">Invite links can be used once and expire after seven days.</p>
              <Button type="submit" variant="primary" busy={create.pending}>
                Create invite link
              </Button>
              {create.error !== undefined && <ErrorMessage error={create.error} />}
            </form>
            {invites.loading && <Loading label="Loading invites…" />}
            {invites.error !== undefined && (
              <ErrorMessage error={invites.error} onRetry={() => invites.refresh()} />
            )}
            {revoke.error !== undefined && <ErrorMessage error={revoke.error} />}
            {invites.data?.invites.length === 0 && (
              <p className="muted">No active or used invite links.</p>
            )}
            <ul className="record-list">
              {invites.data?.invites.map((invite) => (
                <li key={invite.id} className="record-card">
                  <p>
                    <strong>{invite.role}</strong> ·{" "}
                    {invite.languages?.join(", ") ?? "All languages"} ·{" "}
                    {invite.usedAt
                      ? `Used by ${invite.usedBy?.name ?? "a member"}`
                      : invite.expiresAt <= Date.now()
                        ? "Expired"
                        : "Available"}
                  </p>
                  <p className="muted">Expires {formatDateTime(invite.expiresAt)}</p>
                  <ConfirmButton
                    title="Revoke this invite?"
                    description="The link will no longer grant access to anyone who opens it."
                    disabled={revoke.pending}
                    onConfirm={() => revoke.run(invite.id)}
                  >
                    Revoke invite
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Tabs>
      <OneTimeSecret title="One-time link" value={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

export function TeamPage() {
  return (
    <Access action="team">
      <Team />
    </Access>
  );
}
