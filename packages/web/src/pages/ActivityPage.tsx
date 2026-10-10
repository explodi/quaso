// SPDX-License-Identifier: MIT
import {
  H1,
  Button,
  EmptyState,
  ActivityIcon,
  CheckSquareIcon,
  FileIcon,
  SparklesIcon,
  UploadIcon,
  Loading,
} from "@quaso/design-system";
/** Activity (design §5.9): uploads, jobs, reviews, imports and renames, newest first, paged. */
import type { ActivityItem, ActivityResult } from "@quaso/core";
import { useEffect, useRef, useState } from "react";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { getActivity, request } from "../lib/api.ts";
import { useMutation, useQuery } from "../lib/data.ts";
import { ConfirmButton } from "../components/Management.tsx";
import { useSession } from "../lib/session.tsx";
import { formatDateTime, formatRelative } from "../lib/format.ts";
import { useDocumentTitle } from "../lib/hooks.ts";

const TYPE_LABELS: Record<ActivityItem["type"], string> = {
  upload: "Upload",
  job: "LLM job",
  review: "Review",
  import: "Import",
  rename: "Rename",
  secret: "Secret",
};

function TypeIcon({ type }: { type: ActivityItem["type"] }) {
  if (type === "upload") return <UploadIcon />;
  if (type === "job") return <SparklesIcon />;
  if (type === "review") return <CheckSquareIcon />;
  if (type === "import") return <FileIcon />;
  return <ActivityIcon />;
}

function RenameSuggestions({ item }: { item: ActivityItem }) {
  const session = useSession();
  const mutation = useMutation(
    (rename: { file: string; from: string; to: string }) =>
      request("/renames", { method: "POST", body: rename }),
    { invalidate: [["activity"], ["project"], ["strings"], ["string"], ["history"]] },
  );
  const candidates = item.detail.renameSuggestions;
  const [applied, setApplied] = useState<string[]>([]);
  if (!session.can("settings") || item.type !== "upload" || !Array.isArray(candidates)) return null;
  const renames = candidates.filter(
    (value): value is { file: string; from: string; to: string } =>
      !!value &&
      typeof value === "object" &&
      typeof value.file === "string" &&
      typeof value.from === "string" &&
      typeof value.to === "string",
  );
  return (
    <div>
      {renames.map((rename) => {
        const key = `${rename.file}:${rename.from}:${rename.to}`;
        return (
          <div className="record-card" key={key}>
            <p>
              Possible rename in {rename.file}: <code>{rename.from}</code> →{" "}
              <code>{rename.to}</code>
            </p>
            {applied.includes(key) ? (
              <p role="status">Rename applied.</p>
            ) : (
              <ConfirmButton
                variant="secondary"
                title="Apply this rename?"
                description={`Translations and history for ${rename.from} will move to ${rename.to}. The old key stays removed. Existing proofread work is protected by the server.`}
                disabled={mutation.pending}
                onConfirm={async () => {
                  await mutation.run(rename);
                  setApplied((values) => [...values, key]);
                }}
              >
                Apply rename
              </ConfirmButton>
            )}
          </div>
        );
      })}
      {mutation.error !== undefined && <ErrorMessage error={mutation.error} />}
    </div>
  );
}

export function ActivityPage() {
  useDocumentTitle("Activity");
  const first = useQuery<ActivityResult>(
    ["activity"],
    ({ fresh }) => getActivity(undefined, undefined, { fresh }),
    {
      refreshInterval: 60_000,
    },
  );
  const [more, setMore] = useState<{
    items: ActivityItem[];
    cursor: string | null;
    after: string | null;
  }>({ items: [], cursor: null, after: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);
  /** The first item loaded by "Show older activity", to focus when the button goes. */
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (focusItem === null) return;
    list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusItem)}"]`)?.focus();
  }, [focusItem]);

  // Pages loaded with "Show older" belong to the first page they followed.
  const firstCursor = first.data?.nextCursor ?? null;
  const extra =
    more.after === firstCursor ? more : { items: [], cursor: firstCursor, after: firstCursor };
  const items = [...(first.data?.items ?? []), ...extra.items];
  const cursor = extra.items.length > 0 ? extra.cursor : firstCursor;

  const loadMore = async () => {
    if (!cursor) return;
    const button = document.activeElement;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await getActivity(cursor);
      setMore({
        items: [...extra.items, ...page.items],
        cursor: page.nextCursor,
        after: firstCursor,
      });
      // The last page: the button goes, and focus with it unless it moves to what's new.
      if (page.nextCursor === null && button?.closest(".load-more") && page.items[0]) {
        setFocusItem(String(page.items[0].id));
      }
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page narrow activity-page">
      <div className="page-head workspace-heading">
        <div>
          <H1 ui>Activity</H1>
          <p className="muted">A shared history of what changed and who helped it happen.</p>
        </div>
      </div>
      {first.error !== undefined && !first.data && (
        <ErrorMessage error={first.error} onRetry={() => first.refresh()} />
      )}
      {first.loading && <Loading label="Loading the activity…" />}
      {first.data && items.length === 0 && (
        <EmptyState icon={<ActivityIcon size={24} />} title="Nothing has happened yet">
          <p>Uploads, LLM jobs, reviews and imports show up here.</p>
        </EmptyState>
      )}
      {items.length > 0 && (
        <ol className="activity-list" ref={list}>
          {items.map((item) => (
            <li
              key={item.id}
              className={`activity-item activity-${item.type}`}
              data-id={item.id}
              tabIndex={-1}
            >
              <span className="activity-icon" aria-hidden="true">
                <TypeIcon type={item.type} />
              </span>
              <div className="activity-body">
                <p className="activity-summary">
                  <span className="sr-only">{TYPE_LABELS[item.type]}:</span> {item.summary}
                </p>
                <p className="activity-meta muted">
                  {item.actor.name} ·{" "}
                  <time dateTime={new Date(item.at).toISOString()} title={formatDateTime(item.at)}>
                    {formatRelative(item.at)}
                  </time>
                </p>
                <RenameSuggestions item={item} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {moreError !== undefined && <ErrorMessage error={moreError} onRetry={loadMore} />}
      {cursor && (
        <div className="load-more">
          <Button onClick={loadMore} busy={loadingMore}>
            Show older activity
          </Button>
        </div>
      )}
    </div>
  );
}
