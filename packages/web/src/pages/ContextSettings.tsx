// SPDX-License-Identifier: MIT
import {
  Button,
  Details,
  FileIcon,
  FolderIcon,
  H2,
  Input,
  Label,
  Select,
  Summary,
  TextArea,
} from "@quaso/design-system";
import { type SettingsResult, UpdateFileRequest, UpdateFolderRequest } from "@quaso/core";
import { useState } from "react";
import { errorMessage, request } from "../lib/api.ts";
import { queryCache } from "../lib/data.ts";
import { validated } from "../lib/forms.ts";
import { useRoute } from "../lib/router.tsx";
import { contextDrafts, useSettingsDrafts } from "../lib/settingsDrafts.ts";
import "../styles/context.css";

type Scope = {
  key: string;
  kind: "file" | "folder";
  id?: number;
  path: string;
  context: string;
  uploadedContext: string | null;
  generatedContext?: string | null;
};
type Filter = "all" | "repository" | "edited" | "empty" | "unsaved";

function contains(folder: string, path: string) {
  return folder === "" || path.startsWith(`${folder}/`);
}
function scopeName(scope: Scope) {
  return scope.path ? `${scope.path}${scope.kind === "folder" ? "/" : ""}` : "All files";
}
function source(scope: Scope, generatedEnabled: boolean) {
  if (scope.uploadedContext !== null) {
    return scope.context === scope.uploadedContext ? "Repository" : "Edited here";
  }
  if (scope.context) return "Written here";
  if (scope.generatedContext && generatedEnabled) return "Generated";
  return "No own context";
}

export function ContextSettings({ data }: { data: SettingsResult }) {
  const { query, setQuery } = useRoute();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const { drafts } = useSettingsDrafts(contextDrafts);
  const scopes: Scope[] = [
    ...data.folders.map((folder) => ({
      ...folder,
      kind: "folder" as const,
      key: `folder:${folder.path}`,
    })),
    ...data.files.map((file) => ({ ...file, kind: "file" as const, key: `file:${file.id}` })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const generatedEnabled = data.settings.llm.context.fileContext;
  const selected = scopes.find((scope) => scope.key === query.scope) ?? scopes[0];
  const needle = search.trim().toLowerCase();
  const matches = scopes.filter((scope) => {
    if (!scopeName(scope).toLowerCase().includes(needle)) return false;
    if (filter === "repository") return scope.uploadedContext !== null;
    if (filter === "edited") return source(scope, generatedEnabled) === "Edited here";
    if (filter === "empty") return !scope.context;
    if (filter === "unsaved") return drafts.has(scope.key);
    return true;
  });
  const pageSize = 40;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const visible = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const editedCount = scopes.filter(
    (scope) => source(scope, generatedEnabled) === "Edited here",
  ).length;
  const draftCount = scopes.filter((scope) => drafts.has(scope.key)).length;
  function changeDraft(scope: Scope, text: string | undefined) {
    contextDrafts.change(scope.key, text === scope.context ? undefined : text);
  }
  return (
    <div className="context-settings">
      <Details className="context-repo-guide">
        <Summary>Keep context in your repository</Summary>
        <p>
          Put <code>context.quaso</code> beside your sources for a folder, or{" "}
          <code>menus.json.quaso</code> beside <code>menus.json</code> for one file. Then run{" "}
          <code>quaso upload</code>.
        </p>
        <p>
          A changed context file replaces the text here. An unchanged file preserves website edits.
          Website edits are never written back to your repository.
        </p>
      </Details>
      <div className="context-overview">
        <p>
          {data.files.length} files <span aria-hidden="true">·</span> {data.folders.length} folders
        </p>
        {editedCount > 0 && (
          <Button
            variant="plain"
            onClick={() => {
              setFilter("edited");
              setSearch("");
              setPage(0);
            }}
          >
            {editedCount} edited here
          </Button>
        )}
        {draftCount > 0 && (
          <span role="status">
            {draftCount} unsaved {draftCount === 1 ? "draft" : "drafts"} — kept while you browse
          </span>
        )}
      </div>
      {scopes.length === 0 ? (
        <p className="context-empty">Upload your source files to start adding context.</p>
      ) : (
        <div className="context-workspace">
          <section className="context-browser" aria-label="Context scopes">
            <div className="context-search">
              <Label className="field">
                Search folders and files
                <Input
                  type="search"
                  placeholder="Find a path…"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                />
              </Label>
              <Label className="context-filter">
                Show
                <Select
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value as Filter);
                    setPage(0);
                  }}
                >
                  <option value="all">All scopes</option>
                  <option value="repository">Repository</option>
                  <option value="edited">Edited here</option>
                  <option value="empty">No own context</option>
                  <option value="unsaved">Unsaved drafts</option>
                </Select>
              </Label>
            </div>
            <p className="context-result-count" role="status">
              {matches.length} {matches.length === 1 ? "scope" : "scopes"}
              {needle || filter !== "all" ? " found" : ""}
            </p>
            <ul className="context-list">
              {visible.map((scope) => (
                <li key={scope.key}>
                  <Button
                    variant="plain"
                    className="context-scope"
                    data-scope={scope.key}
                    aria-current={selected?.key === scope.key ? "true" : undefined}
                    onClick={() => {
                      setQuery({ scope: scope.key });
                      requestAnimationFrame(() =>
                        document.getElementById("context-editor-heading")?.focus(),
                      );
                    }}
                  >
                    {scope.kind === "folder" ? <FolderIcon /> : <FileIcon />}
                    <span>
                      <span className="context-scope-path">{scopeName(scope)}</span>
                      <span className="context-scope-source">
                        {source(scope, generatedEnabled)}
                        {drafts.has(scope.key) ? " · Unsaved" : ""}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            {matches.length === 0 && (
              <div className="context-empty">
                <p>No matching folders or files.</p>
                <Button
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                    setPage(0);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
            {matches.length > pageSize && (
              <nav className="context-pagination" aria-label="Context pages">
                <Button
                  size="small"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous
                </Button>
                <span>
                  {currentPage + 1} / {Math.ceil(matches.length / pageSize)}
                </span>
                <Button
                  size="small"
                  disabled={(currentPage + 1) * pageSize >= matches.length}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                </Button>
              </nav>
            )}
          </section>
          {selected && (
            <ContextEditor
              key={selected.key}
              scope={selected}
              data={data}
              text={drafts.get(selected.key) ?? selected.context}
              change={(text) => changeDraft(selected, text)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ContextEditor({
  scope,
  data,
  text,
  change,
}: {
  scope: Scope;
  data: SettingsResult;
  text: string;
  change(text: string | undefined): void;
}) {
  const { saving } = useSettingsDrafts(contextDrafts);
  const busy = saving.has(scope.key);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const dirty = text !== scope.context;
  const isFolder = scope.kind === "folder";
  const fileName = isFolder ? "context.quaso" : `${scope.path.split("/").at(-1)}.quaso`;
  const count = isFolder ? data.files.filter((file) => contains(scope.path, file.path)).length : 1;
  const generatedEnabled = data.settings.llm.context.fileContext;
  const inherited = data.folders
    .filter(
      (folder) => folder.path !== scope.path && contains(folder.path, scope.path) && folder.context,
    )
    .sort((a, b) => a.path.length - b.path.length);
  const ownContext = scope.context || (generatedEnabled ? scope.generatedContext : "");
  const preview = [
    ...inherited.map((folder) => ({
      label: folder.path ? `${folder.path}/` : "All files",
      text: folder.context,
    })),
    ...(ownContext
      ? [{ label: `${scopeName(scope)}${!scope.context ? " (generated)" : ""}`, text: ownContext }]
      : []),
  ];
  // Announcements belong to the current draft, not a previous successful save or copy.
  function edit(value: string | undefined) {
    setNotice("");
    setError(undefined);
    change(value);
  }
  return (
    <section className="context-editor" aria-label="Context editor">
      <header className="context-editor-heading">
        <p className="context-kicker">
          {isFolder ? "Folder" : "File"} context{" "}
          <span className="context-source-badge">{source(scope, generatedEnabled)}</span>
        </p>
        <H2 ui id="context-editor-heading" tabIndex={-1}>
          {scopeName(scope)}
        </H2>
        <p>
          {isFolder
            ? `Applies to ${count} ${count === 1 ? "file" : "files"}, including subfolders.`
            : "Applies to this file, after its folder contexts."}
        </p>
      </header>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !dirty) return;
          setError(undefined);
          setNotice("");
          try {
            const saved = await contextDrafts.save(scope.key, text, async () => {
              await request(isFolder ? "/folders" : `/files/${scope.id}`, {
                method: "PATCH",
                body: isFolder
                  ? validated(UpdateFolderRequest, { path: scope.path, context: text })
                  : validated(UpdateFileRequest, { context: text }),
              });
              await queryCache.fetch(["settings"], undefined, { force: true });
            });
            if (saved) setNotice("Saved. Used the next time these strings are translated.");
          } catch (caught) {
            setError(caught);
          }
        }}
      >
        <div className="context-writing">
          <Label className="field" htmlFor="context-text">
            Context for this {scope.kind}
          </Label>
          <TextArea
            id="context-text"
            autoGrow={false}
            rows={9}
            value={text}
            disabled={busy}
            maxLength={20000}
            aria-describedby="context-help context-count"
            onChange={(event) => edit(event.target.value)}
            placeholder={
              isFolder
                ? "Describe the shared voice, audience and meaning of these files…"
                : "Explain where these strings appear and what a translator needs to know…"
            }
          />
          <div className="context-writing-hint">
            <p id="context-help">
              {isFolder
                ? "Added to parent folder guidance. Leave blank to inherit it."
                : "Leave blank to use generated context when available and enabled."}
            </p>
            <span id="context-count">{text.length.toLocaleString()} / 20,000</span>
          </div>
        </div>
        {scope.uploadedContext !== null && (
          <div className="context-repository">
            <p>
              <strong>
                {scope.context === scope.uploadedContext ? "From" : "Edited here since uploading"}{" "}
                <code>{fileName}</code>
              </strong>
            </p>
            <p>Changed files replace website edits on upload. Unchanged files keep them.</p>
            <Details>
              <Summary>Repository text</Summary>
              <pre>{scope.uploadedContext}</pre>
            </Details>
            {text !== scope.uploadedContext && (
              <Button size="small" disabled={busy} onClick={() => edit(scope.uploadedContext!)}>
                Use the file's text
              </Button>
            )}
          </div>
        )}
        {error !== undefined && (
          <p role="alert" className="field-error context-feedback">
            {errorMessage(error)}
          </p>
        )}
        <footer className="context-save">
          <div>
            <Button type="submit" variant="primary" disabled={!dirty} busy={busy}>
              Save context
            </Button>
            <Button disabled={!dirty || busy} onClick={() => edit(undefined)}>
              Discard changes
            </Button>
            <Button
              variant="ghost"
              disabled={!text || busy}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setNotice(
                    `Copied. Paste into ${fileName} in your repository to keep it in sync.`,
                  );
                } catch {
                  setError(
                    new Error("Could not copy. Select the context text and copy it manually."),
                  );
                }
              }}
            >
              Copy context
            </Button>
          </div>
          <p role="status">{notice || (dirty ? "Unsaved changes" : "No unsaved changes")}</p>
        </footer>
      </form>
      <Details className="context-preview">
        <Summary>
          {isFolder ? "Context shared with these files" : "Context read for this file"}
        </Summary>
        <p>
          Saved context, in reading order. Folder guidance adds up; the file's own text comes last.
        </p>
        {preview.length ? (
          <ol>
            {preview.map((part) => (
              <li key={part.label}>
                <strong>{part.label}</strong>
                <pre>{part.text}</pre>
              </li>
            ))}
          </ol>
        ) : (
          <p>No saved context for this scope yet.</p>
        )}
        {isFolder && (
          <p>Each file may add its own context or generated fallback after this guidance.</p>
        )}
        {!isFolder && scope.generatedContext && (scope.context || !generatedEnabled) && (
          <p>
            Generated context is not used:{" "}
            {scope.context
              ? "this file has its own written context."
              : "Include file context is off in AI translation settings."}
          </p>
        )}
      </Details>
    </section>
  );
}
