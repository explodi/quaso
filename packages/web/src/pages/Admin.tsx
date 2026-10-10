// SPDX-License-Identifier: MIT
import { H2, H3, H1, Loading } from "@quaso/design-system";
import type { AdminInfo } from "@quaso/core";
import { Access } from "../components/Management.tsx";
import { errorMessage, request } from "../lib/api.ts";
import { useQuery } from "../lib/data.ts";
import { useDocumentTitle } from "../lib/hooks.ts";

const date = (value: number | null) =>
  value === null ? "Never" : new Date(value).toLocaleString();
export function AdminDetails({ backupsOnly = false }: { backupsOnly?: boolean }) {
  const query = useQuery(["admin"], ({ fresh }) => request<AdminInfo>("/admin", { fresh }), {
    refreshInterval: 10_000,
  });
  if (query.loading) return <Loading label="Loading instance information…" />;
  if (query.error !== undefined) return <p role="alert">{errorMessage(query.error)}</p>;
  const info = query.data;
  if (!info) return null;
  const backup = (
    <>
      <p>
        Last automatic backup: {date(info.lastBackup?.at ?? null)}
        {info.lastBackup?.file && (
          <>
            · <code>{info.lastBackup.file}</code>
          </>
        )}
      </p>
      {info.setup === "cloudflare" && (
        <p>
          Cloudflare stores nightly backups in R2. For point-in-time recovery, an operator uses the
          protected internal recovery API described in the operations guide.
        </p>
      )}
    </>
  );
  if (backupsOnly) return backup;
  return (
    <>
      <section className="management-section">
        <H2 ui>Instance</H2>
        <dl className="admin-facts">
          <dt>Version</dt>
          <dd>{info.version}</dd>
          <dt>Storage</dt>
          <dd>{info.setup}</dd>
          <dt>Started</dt>
          <dd>{date(info.startedAt)}</dd>
          <dt>Database schema</dt>
          <dd>{info.database.schemaVersion}</dd>
          <dt>Database size</dt>
          <dd>
            {info.database.sizeBytes === null
              ? "Unavailable"
              : `${(info.database.sizeBytes / 1024 / 1024).toFixed(2)} MiB`}
          </dd>
          <dt>Revision</dt>
          <dd>{info.database.revision}</dd>
        </dl>
      </section>
      <section className="management-section">
        <H2 ui>Jobs and translator</H2>
        <p>
          {info.jobs.queued} queued · {info.jobs.running} running · {info.jobs.paused} paused
        </p>
        <p>
          Provider: {info.llm.provider ?? "Not configured"} · Model: {info.llm.model}
        </p>
        <p>Last success: {date(info.llm.lastSuccessAt)}</p>
        {info.llm.lastError && (
          <p role="status">
            Last translator error ({date(info.llm.lastError.at)}): {info.llm.lastError.message}
          </p>
        )}
        <H3 ui>Usage this month</H3>
        <dl className="admin-usage">
          {Object.entries(info.usageThisMonth).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
              <dd>{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="management-section">
        <H2 ui>Backups</H2>
        {backup}
      </section>
      <section className="management-section">
        <H2 ui>Recent errors</H2>
        {info.recentErrors.length === 0 ? (
          <p>No recent errors.</p>
        ) : (
          <ol>
            {info.recentErrors.map((error, i) => (
              <li key={i}>
                <time>{date(error.at)}</time>: {error.message}
                {error.requestId && <code>({error.requestId})</code>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
export function AdminPage() {
  useDocumentTitle("Administration");
  return (
    <Access action="settings">
      <div className="page management-page admin-page">
        <div className="page-head workspace-heading">
          <div>
            <H1 ui>Administration</H1>
            <p className="muted">
              Check the health, storage and recent errors of this Quaso instance.
            </p>
          </div>
        </div>
        <div className="admin-grid">
          <AdminDetails />
        </div>
      </div>
    </Access>
  );
}
