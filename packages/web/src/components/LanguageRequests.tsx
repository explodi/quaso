// SPDX-License-Identifier: MIT
import { H2, H3, Button, Dialog, Field, Label, Select, Loading } from "@quaso/design-system";
/** Community requests on the dashboard and administrator decisions in Settings. */
import { SUPPORTED_LANGUAGES, type LanguageRequestInfo } from "@quaso/core";
import { useState } from "react";
import {
  listLanguageRequests,
  requestLanguage,
  reviewLanguageRequest,
} from "../lib/community-api.ts";
import { queryCache, useQuery } from "../lib/data.ts";
import { fieldError } from "../lib/forms.ts";
import { useProject } from "../lib/hooks.ts";
import { useSession } from "../lib/session.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { HumanCheck } from "./HumanCheck.tsx";
import { TextField } from "./Management.tsx";
import { useToast } from "./Toast.tsx";

function useRequests() {
  const session = useSession();
  return useQuery(["language-requests", session.user?.id ?? null], listLanguageRequests, {
    staleTime: 5000,
  });
}
async function refreshRequests() {
  await Promise.all([
    queryCache.invalidate(["language-requests"]),
    queryCache.invalidate(["project"]),
    queryCache.invalidate(["settings"]),
  ]);
}

export function LanguageRequests() {
  const session = useSession();
  const requests = useRequests();
  const [dialog, setDialog] = useState<"new" | LanguageRequestInfo | null>(null);
  return (
    <section className="card language-requests" aria-labelledby="requests-heading">
      <div className="card-head">
        <div>
          <H2 id="requests-heading">Requested languages</H2>
          <p className="muted">Help the team choose which language to add next.</p>
        </div>
        {session.user && <Button onClick={() => setDialog("new")}>Request a language</Button>}
      </div>
      {!session.user && <p className="pad muted">Sign in to vote.</p>}
      {requests.error !== undefined && (
        <ErrorMessage error={requests.error} onRetry={() => requests.refresh()} />
      )}
      {requests.loading && <Loading label="Loading language requests…" />}
      {requests.data?.requests.length === 0 && (
        <p className="pad muted">No language requests are waiting.</p>
      )}
      <ul className="community-records request-list">
        {requests.data?.requests.map((request) => (
          <li className="community-record" key={request.id}>
            <div className="community-record-head">
              <H3>
                {request.name} <span className="muted small">{request.tag}</span>
              </H3>
              <span className="vote-count">
                {request.votes} {request.votes === 1 ? "vote" : "votes"}
              </span>
            </div>
            {request.message && <p className="community-text">{request.message}</p>}
            <p className="muted small">Requested by {request.requestedBy?.name ?? "the team"}</p>
            {session.user && (
              <Button size="small" disabled={request.voted} onClick={() => setDialog(request)}>
                {request.voted ? "Voted" : "Vote for this language"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {dialog !== null && (
        <RequestDialog
          existing={dialog === "new" ? null : dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function RequestDialog({
  existing,
  onClose,
}: {
  existing: LanguageRequestInfo | null;
  onClose(): void;
}) {
  const project = useProject();
  const session = useSession();
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState(existing?.tag ?? "");
  const [message, setMessage] = useState("");
  const [humanCheck, setHumanCheck] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  const canonical = tag;
  const unavailable = new Set([
    project.data?.sourceLanguage,
    ...(project.data?.languages.map((l) => l.tag) ?? []),
  ]);
  return (
    <Dialog
      open
      title={existing ? `Vote for ${existing.name}` : "Request a language"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await requestLanguage({
              tag: tag.trim(),
              message,
              humanCheck: humanCheck || undefined,
            });
            await refreshRequests();
            toast.show(
              existing ? "Your vote was added." : "Language requested. Your vote was added.",
            );
            onClose();
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error !== undefined && <ErrorMessage error={error} />}
        {existing ? (
          <p>Add your vote for {existing.name}. Each person has one vote per language.</p>
        ) : (
          <>
            <Field
              label="Search languages"
              placeholder="Name, native name or language tag"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              data-autofocus
            />
            <Label className="field">
              Language
              <Select
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                required
                aria-invalid={!!fieldError(error, "tag")}
              >
                <option value="">Choose a language</option>
                {SUPPORTED_LANGUAGES.filter((language) => {
                  if (unavailable.has(language.tag)) return false;
                  const name =
                    `${language.name} ${language.nativeName} ${language.tag}`.toLocaleLowerCase();
                  return language.tag === tag || name.includes(search.trim().toLocaleLowerCase());
                }).map((language) => (
                  <option key={language.tag} value={language.tag}>
                    {language.name} — {language.nativeName} ({language.tag})
                  </option>
                ))}
              </Select>
            </Label>
            <TextField
              label="Message (optional)"
              value={message}
              onChange={setMessage}
              maxLength={500}
            />
          </>
        )}
        <HumanCheck onToken={setHumanCheck} />
        <div className="actions">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={
              !!(session.info.humanCheck && !humanCheck) || !canonical || unavailable.has(canonical)
            }
          >
            {existing ? "Add my vote" : "Send language request"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Mount in Settings' languages section. Approval uses the regular add-language path. */
export function LanguageRequestsAdmin() {
  const requests = useRequests();
  const session = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  if (!session.can("settings")) return null;
  const review = async (request: LanguageRequestInfo, action: "approve" | "reject") => {
    setBusy(request.id);
    setError(undefined);
    try {
      await reviewLanguageRequest(request.id, { action });
      await refreshRequests();
      toast.show(
        action === "approve"
          ? `${request.name} added to the project.`
          : `${request.name} request rejected.`,
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      className="card language-requests-admin"
      aria-labelledby="language-requests-admin-heading"
    >
      <div className="card-head">
        <H2 id="language-requests-admin-heading">Language requests</H2>
      </div>
      {error !== undefined && <ErrorMessage error={error} />}
      {requests.error !== undefined && (
        <ErrorMessage error={requests.error} onRetry={() => requests.refresh()} />
      )}
      {requests.loading && <Loading label="Loading language requests…" />}
      {requests.data?.requests.length === 0 && (
        <p className="pad muted">No language requests are waiting.</p>
      )}
      <ul className="community-records">
        {requests.data?.requests.map((request) => (
          <li className="community-record" key={request.id}>
            <H3>
              {request.name}{" "}
              <span className="muted small">
                {request.tag} · {request.votes} {request.votes === 1 ? "vote" : "votes"}
              </span>
            </H3>
            {request.message && <p className="community-text">{request.message}</p>}
            <p className="muted small">Requested by {request.requestedBy?.name ?? "the team"}</p>
            <div className="actions">
              <Button
                variant="primary"
                busy={busy === request.id}
                disabled={busy !== null}
                onClick={() => review(request, "approve")}
              >
                Approve language
              </Button>
              <Button disabled={busy !== null} onClick={() => review(request, "reject")}>
                Reject language
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
