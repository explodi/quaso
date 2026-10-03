// SPDX-License-Identifier: MIT
import { H3 } from "../../components/Typography.tsx";
import { Label, Checkbox } from "../../components/Controls.tsx";
/** The editor's discussions and matching terminology. */
import type { CommentInfo, StringDetail } from "@quaso/core";
import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { ConfirmButton, TextField } from "../../components/Management.tsx";
import { Loading } from "../../components/Spinner.tsx";
import { useToast } from "../../components/Toast.tsx";
import {
  addComment,
  deleteComment,
  listComments,
  resolveComment,
} from "../../lib/community-api.ts";
import { queryCache, useQuery } from "../../lib/data.ts";
import { formatDateTime } from "../../lib/format.ts";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";

export function GlossaryPanel({ detail }: { detail: StringDetail }) {
  return (
    <div className="pad">
      <p>
        <Link to="/glossary">Browse the glossary</Link>
      </p>
      {detail.glossary.length === 0 ? (
        <p className="muted">No glossary terms occur in this string.</p>
      ) : (
        <dl className="glossary-definitions">
          {detail.glossary.map((term) => (
            <div key={term.id}>
              <dt>{term.term}</dt>
              <dd>
                {term.kind === "keep" ? "Never translate; keep unchanged." : term.translation}
                {term.note && <p className="muted">{term.note}</p>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function CommentsPanel({ detail }: { detail: StringDetail }) {
  const session = useSession();
  const [cursor, setCursor] = useState<string>();
  const comments = useQuery(
    ["comments", detail.id, detail.language, cursor],
    (options) => listComments({ language: detail.language, cursor }, detail.id, options),
    { staleTime: 5000 },
  );
  const [body, setBody] = useState("");
  const [sourceIssue, setSourceIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  const canComment = session.can("comment", sourceIssue ? undefined : detail.language);
  const changed = async () => {
    await queryCache.invalidate(["comments"]);
  };
  return (
    <div className="pad comments-panel">
      {error !== undefined && <ErrorMessage error={error} />}
      {comments.error !== undefined && (
        <ErrorMessage error={comments.error} onRetry={() => comments.refresh()} />
      )}
      {comments.loading && <Loading label="Loading comments…" />}
      {comments.data?.total === 0 && (
        <p className="muted">
          No comments yet. Discuss the translation or flag a problem in the English.
        </p>
      )}
      <ul className="community-records">
        {comments.data?.comments.map((comment) => (
          <Comment key={comment.id} comment={comment} onChanged={changed} />
        ))}
      </ul>
      {(cursor || comments.data?.nextCursor) && (
        <div className="actions">
          <Button disabled={!cursor} onClick={() => setCursor(undefined)}>
            Newest comments
          </Button>
          <Button
            disabled={!comments.data?.nextCursor}
            onClick={() => setCursor(comments.data?.nextCursor ?? undefined)}
          >
            Older comments
          </Button>
        </div>
      )}
      {session.user ? (
        <form
          className="form comment-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              await addComment(detail.id, {
                body,
                sourceIssue,
                language: sourceIssue ? null : detail.language,
              });
              setBody("");
              setSourceIssue(false);
              setCursor(undefined);
              await changed();
              toast.show("Comment posted.");
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label="Comment" value={body} onChange={setBody} maxLength={4000} />
          <Label className="check-label">
            <Checkbox checked={sourceIssue} onChange={(e) => setSourceIssue(e.target.checked)} />
            Problem in the English
          </Label>
          {!canComment && (
            <p className="muted">
              Comments need contributor access or a pending volunteer request for this project.
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!canComment || !body.trim()}
          >
            Post comment
          </Button>
        </form>
      ) : (
        <p>
          <Link to="/signin">Sign in</Link> to join the discussion.
        </p>
      )}
    </div>
  );
}

export function Comment({
  comment,
  onChanged,
  link,
}: {
  comment: CommentInfo;
  onChanged(): Promise<void>;
  link?: string;
}) {
  const session = useSession();
  const mine = session.user?.id === comment.author.id && comment.author.type === "user";
  const canResolve = mine || session.can("review", comment.language ?? undefined);
  const canDelete = mine || session.can("settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <li className="community-record comment-record">
      {link && (
        <H3>
          <Link to={link}>
            {comment.file} · {comment.key}
          </Link>
        </H3>
      )}
      <div className="community-record-head">
        <strong>{comment.author.name}</strong>
        <time dateTime={new Date(comment.createdAt).toISOString()} className="muted small">
          {formatDateTime(comment.createdAt)}
        </time>
      </div>
      {comment.sourceIssue && <p className="source-issue-label">Problem in the English</p>}
      <p className="community-text">{comment.body}</p>
      {comment.resolvedAt !== null && (
        <p className="muted small">
          Resolved{comment.resolvedBy && ` by ${comment.resolvedBy.name}`}
        </p>
      )}
      {error !== undefined && <ErrorMessage error={error} />}
      <div className="actions">
        {canResolve && comment.resolvedAt === null && (
          <Button
            size="small"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await resolveComment(comment.id);
                await onChanged();
              } catch (caught) {
                setError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            Resolve
          </Button>
        )}
        {canDelete && (
          <ConfirmButton
            title="Delete this comment?"
            description="The comment will be removed from the discussion."
            disabled={busy}
            onConfirm={async () => {
              setError(undefined);
              try {
                await deleteComment(comment.id);
                await onChanged();
              } catch (caught) {
                setError(caught);
                throw caught;
              }
            }}
          >
            Delete comment
          </ConfirmButton>
        )}
      </div>
    </li>
  );
}
