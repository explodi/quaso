// SPDX-License-Identifier: MIT
/**
 * Context files: text in the repository that an upload stores as a file's or folder's context.
 * A person can still edit that context on the website, so `uploaded_context` remembers the text
 * last uploaded. Comparing the three texts gives one rule: a changed file always wins, and an
 * unchanged file never overwrites.
 */
import type { UploadContextChange, UploadRequest } from "@quaso/core";
import { badRequest } from "./errors.ts";
import type { FolderRow } from "./folders.ts";
import type { Statement } from "./ports.ts";

/** What an upload does to one context; `text` and `uploaded` are what it then stores. */
export type ContextOutcome =
  | { kind: "unchanged" }
  /** The file is unchanged and someone edited the context on the website: their text stays. */
  | { kind: "edited" }
  /** The file is new or changed, so its text becomes the context. */
  | { kind: "set"; text: string; uploaded: string }
  /** As `set`, over a different text someone wrote on the website. */
  | { kind: "replaced"; text: string; uploaded: string }
  /** The file now matches the context, so nothing visible changes. */
  | { kind: "matched"; text: string; uploaded: string }
  /** The file is gone and nobody edited its text, so the context goes too. */
  | { kind: "cleared"; text: ""; uploaded: null }
  /** The file is gone, but someone edited the context on the website: their text stays. */
  | { kind: "detached"; text: string; uploaded: null };

/**
 * The rule, for one context: `current` is the stored context, `lastUploaded` the text last
 * uploaded from its file (null without one) and `fileText` what the file holds now (null
 * without one). A blank file counts as no file.
 */
export function decideContext(
  current: string,
  lastUploaded: string | null,
  fileText: string | null,
): ContextOutcome {
  const text = fileText === null || fileText.trim() === "" ? null : fileText;
  if (text === null) {
    if (lastUploaded === null) return { kind: "unchanged" };
    if (current === lastUploaded) return { kind: "cleared", text: "", uploaded: null };
    return { kind: "detached", text: current, uploaded: null };
  }
  if (text === lastUploaded) {
    return current === text ? { kind: "unchanged" } : { kind: "edited" };
  }
  if (current === text) return { kind: "matched", text, uploaded: text };
  const overwritesAnEdit = current.trim() !== "" && current !== lastUploaded;
  return { kind: overwritesAnEdit ? "replaced" : "set", text, uploaded: text };
}

type Target = {
  change: Pick<UploadContextChange, "target" | "path">;
  /** How warnings name the context file. */
  fileName: string;
  outcome: ContextOutcome;
};

function warningFor({ fileName, outcome }: Target): string | null {
  if (outcome.kind === "edited") {
    return (
      `${fileName}: this context was edited on the website, so the upload kept that text. ` +
      "To keep it, copy it into the file. To drop it, choose Use the file's text in Settings."
    );
  }
  if (outcome.kind === "replaced") {
    return `${fileName} replaced a different context that was written on the website.`;
  }
  if (outcome.kind === "detached") {
    return `${fileName} is gone, but its context was edited on the website, so that text stays.`;
  }
  return null;
}

function folderFileName(path: string): string {
  return path === "" ? "The top folder's context.quaso" : `context.quaso in folder ${path}`;
}

function folderWrite(path: string, text: string, uploaded: string | null, at: number): Statement {
  if (text.trim() === "" && uploaded === null) {
    return { sql: "DELETE FROM folders WHERE path = ?", params: [path] };
  }
  return {
    sql: `INSERT INTO folders (path, context, uploaded_context, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET context = excluded.context,
      uploaded_context = excluded.uploaded_context, updated_at = excluded.updated_at`,
    params: [path, text, uploaded, at],
  };
}

function folderTargets(request: UploadRequest, rows: FolderRow[], at: number) {
  const texts = new Map<string, string>();
  for (const { path, context } of request.folderContexts ?? []) {
    if (texts.has(path)) throw badRequest(`The upload has the context of folder "${path}" twice.`);
    texts.set(path, context);
  }
  const stored = new Map(rows.map((row) => [row.path, row]));
  const paths = new Set([...texts.keys(), ...stored.keys()]);
  return [...paths].sort().map((path) => {
    const row = stored.get(path);
    const outcome = decideContext(
      row?.context ?? "",
      row?.uploaded_context ?? null,
      texts.get(path) ?? null,
    );
    const target: Target = {
      change: { target: "folder", path },
      fileName: folderFileName(path),
      outcome,
    };
    const write = "text" in outcome ? folderWrite(path, outcome.text, outcome.uploaded, at) : null;
    return { target, write };
  });
}

/**
 * Plans what an upload's context files change. `files` are the uploaded files' rows by path,
 * after the upload added any new ones.
 */
export function planUploadContexts(
  request: UploadRequest,
  files: ReadonlyMap<string, { id: number; context: string; uploaded_context: string | null }>,
  folders: FolderRow[],
  at: number,
): { statements: Statement[]; changes: UploadContextChange[]; warnings: string[] } {
  const statements: Statement[] = [];
  const changes: UploadContextChange[] = [];
  const warnings: string[] = [];
  // An older client sends neither, and its silence doesn't mean the context files are gone.
  if (request.folderContexts === undefined) return { statements, changes, warnings };

  const record = (target: Target, write: Statement | null) => {
    if (write !== null) statements.push(write);
    const warning = warningFor(target);
    if (warning !== null) warnings.push(warning);
    const { kind } = target.outcome;
    if (kind === "set" || kind === "replaced") changes.push({ ...target.change, change: "set" });
    if (kind === "cleared") changes.push({ ...target.change, change: "cleared" });
  };
  for (const file of request.files) {
    const row = files.get(file.path)!;
    const outcome = decideContext(row.context, row.uploaded_context, file.context ?? null);
    const write =
      "text" in outcome
        ? {
            sql: "UPDATE files SET context = ?, uploaded_context = ?, updated_at = ? WHERE id = ?",
            params: [outcome.text, outcome.uploaded, at, row.id],
          }
        : null;
    record(
      { change: { target: "file", path: file.path }, fileName: `${file.repoPath}.quaso`, outcome },
      write,
    );
  }
  // A partial upload names some files, so folders it doesn't mention may still have context files.
  if (!request.partial) {
    for (const { target, write } of folderTargets(request, folders, at)) record(target, write);
  }
  return { statements, changes, warnings };
}
