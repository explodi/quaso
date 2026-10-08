// SPDX-License-Identifier: MIT
import { H1, Button, Loading } from "@quaso/design-system";
/** Managers' unresolved problems in the English, linked back to the editor. */

import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Access } from "../components/Management.tsx";
import { listComments } from "../lib/community-api.ts";
import { queryCache, useQuery } from "../lib/data.ts";
import { useDocumentTitle, useProject } from "../lib/hooks.ts";
import { useRoute } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { Comment } from "./editor/CommunityTabs.tsx";
import { editorHref } from "./LanguagePage.tsx";

export function IssuesPage() {
  useDocumentTitle("Problems in the English");
  return (
    <Access action="issues">
      <Issues />
    </Access>
  );
}
function Issues() {
  const { query, setQuery } = useRoute();
  const project = useProject();
  const session = useSession();
  const issues = useQuery(["comments", "issues", query.cursor], (options) =>
    listComments({ sourceIssue: true, resolved: false, cursor: query.cursor }, undefined, options),
  );
  const language =
    project.data?.languages.find((l) => session.can("review", l.tag))?.tag ??
    project.data?.languages[0]?.tag;
  return (
    <div className="page issues-page">
      <div className="page-head">
        <div>
          <H1>Problems in the English</H1>
          <p className="muted">Unresolved source issues reported by the community.</p>
        </div>
      </div>
      {issues.error !== undefined && (
        <ErrorMessage error={issues.error} onRetry={() => issues.refresh()} />
      )}
      {issues.loading && <Loading label="Loading source issues…" />}
      {issues.data && (
        <p role="status">
          {issues.data.total} unresolved {issues.data.total === 1 ? "issue" : "issues"}
        </p>
      )}
      {issues.data?.total === 0 && (
        <p className="card pad">No unresolved problems in the English.</p>
      )}
      <ul className="community-records card">
        {issues.data?.comments.map((comment) => (
          <Comment
            key={comment.id}
            comment={comment}
            link={language ? editorHref(language, { id: comment.stringId }) : undefined}
            onChanged={() => queryCache.invalidate(["comments"])}
          />
        ))}
      </ul>
      {(query.cursor || issues.data?.nextCursor) && (
        <div className="actions">
          <Button disabled={!query.cursor} onClick={() => setQuery({ cursor: undefined })}>
            Newest issues
          </Button>
          <Button
            disabled={!issues.data?.nextCursor}
            onClick={() => setQuery({ cursor: issues.data?.nextCursor ?? undefined })}
          >
            Older issues
          </Button>
        </div>
      )}
    </div>
  );
}
