// SPDX-License-Identifier: MIT
/**
 * The file tree of the language page and the editor: folders from the files' paths, with
 * progress added up per folder, filtered by name and by "hide completed".
 */
import type { FileProgress, Progress, SourceFileInfo } from "@quaso/core";
import { isCompleted } from "./states.ts";

export interface TreeFile {
  type: "file";
  /** The last part of the path: `main.json`. */
  name: string;
  /** The server identity used in editor links. */
  path: string;
  repoPath: string;
  depth: number;
  progress: FileProgress | SourceFileInfo;
}

export interface TreeFolder {
  type: "folder";
  name: string;
  /** The repository folder path, with a trailing slash. */
  path: string;
  depth: number;
  progress: Progress | SourceCounts;
  children: TreeNode[];
}

export type SourceCounts = Pick<SourceFileInfo, "strings" | "words">;

export function hasProgress(counts: SourceCounts): counts is Progress {
  return "translatedPercent" in counts;
}

export type TreeNode = TreeFile | TreeFolder;

const COUNTS = [
  "strings",
  "words",
  "untranslated",
  "green",
  "blue",
  "outdated",
  "pending",
  "qa",
  "wordsLeft",
] as const;

/**
 * Adds up progress. Translated words are exact (`words - wordsLeft`); proofread words are
 * estimated from each part's rounded percentage, since the API sends no proofread word count.
 */
export function sumProgress(parts: readonly Progress[]): Progress {
  const total: Progress = {
    strings: 0,
    words: 0,
    untranslated: 0,
    green: 0,
    blue: 0,
    outdated: 0,
    pending: 0,
    qa: 0,
    wordsLeft: 0,
    translatedPercent: 0,
    proofreadPercent: 0,
  };
  let proofreadWords = 0;
  for (const part of parts) {
    for (const name of COUNTS) total[name] += part[name];
    proofreadWords += (part.words * part.proofreadPercent) / 100;
  }
  if (total.words > 0) {
    total.translatedPercent = Math.floor(((total.words - total.wordsLeft) * 100) / total.words);
    total.proofreadPercent = Math.min(
      total.translatedPercent,
      Math.floor((proofreadWords * 100) / total.words),
    );
  } else if (total.strings > 0 && total.untranslated === 0) {
    total.translatedPercent = 100;
    total.proofreadPercent = total.blue === total.strings ? 100 : 0;
  }
  return total;
}

/** Builds the tree: folders first, then files, each sorted by name. */
export function buildTree(files: readonly (FileProgress | SourceFileInfo)[]): TreeNode[] {
  interface Draft {
    folders: Map<string, Draft & { name: string; path: string }>;
    files: TreeFile[];
  }
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.repoPath.split("/");
    let folder = root;
    let path = "";
    for (const part of parts.slice(0, -1)) {
      path += `${part}/`;
      let next = folder.folders.get(part);
      if (!next) {
        next = { name: part, path, folders: new Map(), files: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.push({
      type: "file",
      name: parts[parts.length - 1],
      path: file.path,
      repoPath: file.repoPath,
      depth: parts.length - 1,
      progress: file,
    });
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, "en", { numeric: true });
  const finish = (draft: Draft, depth: number): TreeNode[] => {
    const folders = [...draft.folders.values()].sort(byName).map((folder): TreeFolder => {
      const children = finish(folder, depth + 1);
      const parts: SourceCounts[] = leaves(children).map((leaf) => leaf.progress);
      const progress = parts.every(hasProgress)
        ? sumProgress(parts)
        : {
            strings: parts.reduce((total, part) => total + part.strings, 0),
            words: parts.reduce((total, part) => total + part.words, 0),
          };
      return {
        type: "folder",
        name: folder.name,
        path: folder.path,
        depth,
        children,
        progress,
      };
    });
    return [...folders, ...[...draft.files].sort(byName)];
  };
  return finish(root, 0);
}

/** Every file below the nodes. */
export function leaves(nodes: readonly TreeNode[]): TreeFile[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node] : leaves(node.children)));
}

/**
 * The tree with only files whose path contains `text` (ignoring case) and, with
 * `hideCompleted`, that aren't completed; folders left empty disappear.
 */
export function filterTree(
  nodes: readonly TreeNode[],
  text: string,
  hideCompleted: boolean,
): TreeNode[] {
  const needle = text.trim().toLowerCase();
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      if (needle !== "" && !node.repoPath.toLowerCase().includes(needle)) continue;
      if (hideCompleted && hasProgress(node.progress) && isCompleted(node.progress)) continue;
      result.push(node);
    } else {
      const children = filterTree(node.children, text, hideCompleted);
      if (children.length > 0) result.push({ ...node, children });
    }
  }
  return result;
}

/** The nodes in display order, skipping the children of collapsed folders. */
export function visibleNodes(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.type === "folder" && !collapsed.has(node.path)) {
      result.push(...visibleNodes(node.children, collapsed));
    }
  }
  return result;
}

/** The folder a node is in, or undefined at the top. */
export function parentPath(path: string): string | undefined {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? undefined : trimmed.slice(0, slash + 1);
}
