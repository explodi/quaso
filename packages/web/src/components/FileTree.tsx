// SPDX-License-Identifier: MIT
import {
  A,
  Checkbox,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  Button,
} from "@quaso/design-system";
/**
 * The file tree with progress per file (design §5.9), following the WAI-ARIA tree pattern:
 * ↑ and ↓ move, → opens a folder or moves into it, ← closes it or moves to its parent,
 * Home and End jump, Enter opens a file (or opens and closes a folder). One item is in the
 * Tab order at a time.
 */
import type { Progress } from "@quaso/core";
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { count, formatDateTime, formatPercent, wordsLeftText } from "../lib/format.ts";
import { hasProgress, leaves, parentPath, type TreeNode, visibleNodes } from "../lib/tree.ts";
import { ProgressBar } from "./ProgressBar.tsx";

export interface FileTreeProps {
  nodes: TreeNode[];
  /** The tree's accessible name. */
  label: string;
  /** The selected file's path, if any (`aria-selected`). */
  selected?: string | null;
  /** Opens a file. */
  onOpen(path: string): void;
  /** A link for each file, so it can also be opened in a new tab. */
  hrefFor?(path: string): string;
  /** Extra items above the tree, such as "All files". */
  compact?: boolean;
  columns?: "progress" | "counts";
  /** Folders start open unless listed here. */
  initiallyCollapsed?: string[];
  before?: ReactNode;
  /** Checkbox selection uses server identities; folders select their descendants. */
  selection?: {
    files: readonly string[];
    onChange(files: string[]): void;
    words: ReadonlyMap<string, number>;
  };
}

function Stats({ progress, compact }: { progress: Progress; compact?: boolean }) {
  return (
    <span className="tree-stats">
      <ProgressBar progress={progress} size="small" />
      <span className="tree-percent" aria-hidden="true">
        {formatPercent(progress.translatedPercent)}
        {!compact && (
          <>
            {" • "}
            {formatPercent(progress.proofreadPercent)}
          </>
        )}
      </span>
      {!compact && <span className="tree-left">{wordsLeftText(progress)}</span>}
    </span>
  );
}

export function FileTree(props: FileTreeProps) {
  const { nodes, selected, onOpen, compact } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(props.initiallyCollapsed ?? []),
  );
  const visible = useMemo(() => visibleNodes(nodes, collapsed), [nodes, collapsed]);
  const [focused, setFocused] = useState<string | null>(null);
  const tree = useRef<HTMLUListElement>(null);

  const focusedPath = visible.some((node) => node.path === focused)
    ? focused
    : ((visible.find((node) => node.path === selected) ?? visible[0])?.path ?? null);

  const focusItem = (path: string) => {
    setFocused(path);
    requestAnimationFrame(() => {
      tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
    });
  };

  const toggle = (path: string, open?: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      const isOpen = !next.has(path);
      if (open ?? !isOpen) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const checkState = (node: TreeNode): boolean | "mixed" => {
    const files = leaves([node]);
    const chosen = files.filter((file) => props.selection?.files.includes(file.path)).length;
    if (chosen === 0) return false;
    return chosen === files.length ? true : "mixed";
  };

  const check = (node: TreeNode) => {
    const selection = props.selection;
    if (!selection) return;
    const paths = leaves([node]).map((file) => file.path);
    const next = selection.files.filter((path) => !paths.includes(path));
    if (checkState(node) !== true) next.push(...paths);
    selection.onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = visible.findIndex((node) => node.path === focusedPath);
    const node = visible[index];
    if (!node || event.altKey || event.ctrlKey || event.metaKey) return;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        if (index < visible.length - 1) focusItem(visible[index + 1].path);
        break;
      case "ArrowUp":
        if (index > 0) focusItem(visible[index - 1].path);
        break;
      case "Home":
        focusItem(visible[0].path);
        break;
      case "End":
        focusItem(visible[visible.length - 1].path);
        break;
      case "ArrowRight":
        if (node.type === "folder") {
          if (collapsed.has(node.path)) toggle(node.path, true);
          else if (node.children[0]) focusItem(node.children[0].path);
        }
        break;
      case "ArrowLeft": {
        if (node.type === "folder" && !collapsed.has(node.path)) toggle(node.path, false);
        else {
          const parent = parentPath(node.type === "file" ? node.repoPath : node.path);
          if (parent) focusItem(parent);
          else if (props.selection && node.path !== "") focusItem("");
        }
        break;
      }
      case "Enter":
      case " ":
        if (props.selection) check(node);
        else if (node.type === "folder") toggle(node.path);
        else onOpen(node.path);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const render = (items: TreeNode[]): ReactNode =>
    items.map((node) => {
      const isFolder = node.type === "folder";
      const open = isFolder && !collapsed.has(node.path);
      return (
        <li
          key={node.path}
          role="treeitem"
          aria-level={node.depth + (props.selection ? 2 : 1)}
          aria-expanded={isFolder ? open : undefined}
          aria-selected={isFolder || props.selection ? undefined : node.path === selected}
          aria-checked={props.selection ? checkState(node) : undefined}
          tabIndex={node.path === focusedPath ? 0 : -1}
          data-path={node.path}
          className={`tree-item${node.path === selected ? " tree-selected" : ""}`}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocused(node.path);
          }}
        >
          <div
            className="tree-row"
            style={{
              paddingInlineStart: `${0.5 + (node.depth + (props.selection ? 1 : 0)) * 1.1}rem`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              setFocused(node.path);
              if (props.selection) {
                focusItem(node.path);
                check(node);
              } else if (isFolder) toggle(node.path);
              else if (!(event.target as HTMLElement).closest("a")) onOpen(node.path);
            }}
          >
            {isFolder && props.selection ? (
              <Button
                variant="plain"
                type="button"
                className="tree-expand"
                tabIndex={-1}
                aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  focusItem(node.path);
                  toggle(node.path);
                }}
              >
                {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </Button>
            ) : isFolder ? (
              open ? (
                <ChevronDownIcon className="tree-chevron" />
              ) : (
                <ChevronRightIcon className="tree-chevron" />
              )
            ) : (
              <span className="tree-chevron" />
            )}
            {props.selection && (
              <Checkbox
                aria-hidden="true"
                tabIndex={-1}
                readOnly
                checked={checkState(node) === true}
                ref={(input) => {
                  if (input) input.indeterminate = checkState(node) === "mixed";
                }}
              />
            )}
            {isFolder ? <FolderIcon className="tree-icon" /> : <FileIcon className="tree-icon" />}
            {!isFolder && props.hrefFor ? (
              <A
                className="tree-name"
                href={props.hrefFor(node.path)}
                tabIndex={-1}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
                    return;
                  }
                  event.preventDefault();
                  onOpen(node.path);
                }}
              >
                {node.name}
              </A>
            ) : (
              <span className="tree-name">{node.name}</span>
            )}
            {props.selection ? (
              <span className="tree-stats">
                {count(
                  leaves([node]).reduce(
                    (sum, file) => sum + (props.selection!.words.get(file.path) ?? 0),
                    0,
                  ),
                  "word",
                )}
                {" to translate"}
              </span>
            ) : props.columns === "counts" ? (
              <span className="tree-stats tree-counts">
                <span>{count(node.progress.strings, "string")}</span>
                <span>{count(node.progress.words, "word")}</span>
                {node.type === "file" && "updatedAt" in node.progress && (
                  <time dateTime={new Date(node.progress.updatedAt).toISOString()}>
                    <span className="sr-only">Last changed </span>
                    {formatDateTime(node.progress.updatedAt)}
                  </time>
                )}
              </span>
            ) : hasProgress(node.progress) ? (
              <Stats progress={node.progress} compact={compact} />
            ) : null}
          </div>
          {isFolder && open && (
            <ul role="group" className="tree-group">
              {render(node.children)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <div className={`tree-wrap${props.selection ? " tree-selection" : ""}`}>
      {props.before}
      <ul
        role="tree"
        aria-label={props.label}
        aria-multiselectable={props.selection ? true : undefined}
        className="tree"
        ref={tree}
        onKeyDown={onKeyDown}
      >
        {render(nodes)}
      </ul>
    </div>
  );
}
