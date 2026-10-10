// SPDX-License-Identifier: MIT
import {
  H1,
  H2,
  Button,
  IconButton,
  EmptyState,
  ArrowLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  KeyboardIcon,
  Loading,
} from "@quaso/design-system";
/** Filters and the selected string live in the address so a workspace can be shared. */
import {
  type LanguageFilesResult,
  STATE_FILTERS,
  type StateFilter,
  type StringDetail,
  type StringSummary,
} from "@quaso/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { FileTree } from "../../components/FileTree.tsx";
import { ProgressBar } from "../../components/ProgressBar.tsx";
import { useToast } from "../../components/Toast.tsx";
import {
  approveTranslation,
  createJob,
  errorMessage,
  getString,
  listFiles,
} from "../../lib/api.ts";
import { AutoTranslateButton } from "../../components/AutoTranslate.tsx";
import { queryCache, useQuery } from "../../lib/data.ts";
import { count, formatNumber, languageLabel, progressText } from "../../lib/format.ts";
import { useDocumentTitle, useProject, useRememberLanguage } from "../../lib/hooks.ts";
import { fillPattern, href, Link, Redirect, useRoute } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";
import { isTextInput, shortcutFor } from "../../lib/shortcuts.ts";
import { buildTree } from "../../lib/tree.ts";
import { NotFound } from "../NotFound.tsx";
import { ShortcutsDialog } from "./ShortcutsDialog.tsx";
import { type SideTab, SideTabs } from "./SideTabs.tsx";
import { StringList } from "./StringList.tsx";
import { type PanelHandle, stringKey, TranslationPanel } from "./TranslationPanel.tsx";
import { neighbourIndex, queueCounter, useStringList } from "./useStringList.ts";

/** Polling: the project's revision says when anything changed. */
const POLL = 15_000;
/** Faster for a while after starting an LLM job, so its translations appear quickly. */
const POLL_FAST = 3_000;
const FAST_FOR = 2 * 60_000;

function parseState(value: string | undefined): StateFilter | undefined {
  return (STATE_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as StateFilter)
    : undefined;
}

export function EditorPage() {
  const { params, query, setQuery, location } = useRoute();
  const session = useSession();
  const toast = useToast();
  const [fast, setFast] = useState(false);
  const project = useProject(fast ? POLL_FAST : POLL);
  const language = project.data?.languages.find(
    (l) => l.tag.toLowerCase() === params.lang.toLowerCase(),
  );
  const tag = language?.tag ?? null;
  /** The address spells the tag as the project does (it redirects otherwise). */
  const canonical = language !== undefined && language.tag === params.lang;
  useRememberLanguage(tag);
  const name = language?.name ?? languageLabel(params.lang);
  useDocumentTitle(`Translate into ${name}`);

  const file = query.file || undefined;
  const state = parseState(query.state);
  const q = query.q || undefined;
  const order = query.order === "file" ? "file" : "queue";
  const id = /^\d+$/.test(query.id ?? "") ? Number(query.id) : null;

  const files = useQuery<LanguageFilesResult>(
    tag ? ["files", tag] : null,
    ({ fresh }) => listFiles(tag!, { fresh }),
    { refreshInterval: 30_000 },
  );
  const list = useStringList(tag, { file, state, q, order });
  const selectionScope = JSON.stringify([tag, file, state, q, order]);
  const [selectionState, setSelectionState] = useState<{ scope: string; ids: Set<number> } | null>(
    null,
  );
  const selection =
    selectionState?.scope === selectionScope ? selectionState.ids : new Set<number>();
  const setSelection = (ids: Set<number>) => setSelectionState({ scope: selectionScope, ids });
  const [tab, setTab] = useState<SideTab>("history");
  const [help, setHelp] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"strings" | "translation">(
    id === null ? "strings" : "translation",
  );
  const [focusPanel, setFocusPanel] = useState(false);
  const panel = useRef<PanelHandle>(null);

  // The selection belongs to what the list shows: another file, filter or search clears it,
  // so bulk actions never act on strings that aren't listed.

  // Another string starts at the top of the panel.
  useEffect(() => {
    document.querySelector(".pane-panel")?.scrollTo(0, 0);
  }, [id]);

  // Returning to the scope control keeps focus visible when the file drawer closes.
  const filesWereOpen = useRef(false);
  const returnFocusFromFiles = useRef(true);
  useEffect(() => {
    if (filesOpen) document.querySelector<HTMLElement>("#editor-files .tree-all")?.focus();
    else if (filesWereOpen.current && returnFocusFromFiles.current) {
      document.getElementById("files-toggle")?.focus();
    }
    filesWereOpen.current = filesOpen;
    returnFocusFromFiles.current = true;
  }, [filesOpen]);

  useEffect(() => {
    if (!fast) return;
    const timer = setTimeout(() => setFast(false), FAST_FOR);
    return () => clearTimeout(timer);
  }, [fast]);

  // Without a selected string, select the first one.
  useEffect(() => {
    if (canonical && id === null && !list.previous && list.strings.length > 0) {
      setQuery({ id: list.strings[0].id });
    }
  }, [canonical, id, list.previous, list.strings, setQuery]);

  // When the project changes (someone saved, the LLM translated), refresh what's shown.
  const revision = project.data?.revision;
  const seenRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (revision === undefined) return;
    if (seenRevision.current !== undefined && seenRevision.current !== revision) {
      list.refresh();
      if (tag) queryCache.invalidate(["files", tag]);
      if (id !== null) {
        queryCache.invalidate(["string", id]);
        queryCache.invalidate(["history", id]);
      }
    }
    seenRevision.current = revision;
  }, [revision]);

  const editorPath = fillPattern("/translate/:lang", { lang: tag ?? params.lang });
  const hrefFor = useCallback(
    (stringId: number) => href(editorPath, { file, state, q, order, id: stringId }),
    [editorPath, file, state, q, order],
  );

  const open = (stringId: number, focus: boolean) => {
    setFocusPanel(focus);
    if (focus) setMobilePane("translation");
    setQuery({ id: stringId });
  };

  // Where the selected string was last seen in the list: if it leaves the list (it no longer
  // matches the filter, say), the next string is the one that took its place.
  const lastIndex = useRef(0);
  const selectedIndex = list.strings.findIndex((s) => s.id === id);
  if (selectedIndex >= 0) lastIndex.current = selectedIndex;

  const go = async (delta: 1 | -1, focus: boolean) => {
    const index = list.strings.findIndex((s) => s.id === id);
    const nextIndex = neighbourIndex(index, lastIndex.current, delta);
    let target: StringSummary | undefined = list.strings[nextIndex];
    if (!target && delta > 0 && nextIndex >= list.strings.length && list.hasMore) {
      target = (await list.loadMore())[nextIndex];
    }
    if (target) open(target.id, focus);
    else toast.show(delta > 0 ? "That was the last string." : "This is the first string.", "info");
  };

  const goToDo = async (delta: 1 | -1, focus: boolean) => {
    const target = await list.findToDo(id, delta);
    if (target !== null) open(target, focus);
    else toast.show(delta > 0 ? "No more strings to do." : "No earlier strings to do.", "info");
  };

  const onChanged = async (ids: number[]) => {
    await Promise.all([
      list.refreshStrings(ids).catch(() => {}),
      ...ids.flatMap((stringId) => [
        queryCache.invalidate(["string", stringId]),
        queryCache.invalidate(["history", stringId]),
      ]),
      queryCache.invalidate(["project"]),
      tag ? queryCache.invalidate(["files", tag]) : Promise.resolve(),
    ]);
  };

  const bulkApprove = async (ids: number[]) => {
    if (!tag) return;
    const byId = new Map(list.strings.map((s) => [s.id, s]));
    const listed = ids.map((stringId) => byId.get(stringId)).filter((s) => s !== undefined);
    const green = listed.filter((s) => s.translation?.colour === "green");
    let approved = 0;
    const failures: string[] = [];
    for (let i = 0; i < green.length; i += 4) {
      await Promise.all(
        green.slice(i, i + 4).map(async (s) => {
          try {
            await approveTranslation(s.id, tag, { baseRevision: s.translation!.revision });
            approved++;
          } catch (error) {
            failures.push(`${s.key}: ${errorMessage(error)}`);
          }
        }),
      );
    }
    const skipped = listed.length - green.length;
    const gone = ids.length - listed.length;
    const parts = [`Approved ${count(approved, "string")}.`];
    if (skipped > 0) {
      parts.push(`${count(skipped, "string")} skipped: only green strings can be approved.`);
    }
    if (gone > 0) parts.push(`${count(gone, "string")} skipped: no longer in the list.`);
    if (failures.length > 0) parts.push(`${failures.length} failed (${failures[0]}).`);
    toast.show(parts.join(" "), failures.length > 0 ? "error" : "success");
    if (approved > 0) setSelection(new Set());
    await onChanged(green.map((s) => s.id));
  };

  const bulkTranslate = async (ids: number[]) => {
    if (!tag) return;
    try {
      await createJob({ strings: ids, languages: [tag], retranslate: true });
      toast.show(
        `The LLM is translating ${count(ids.length, "string")}. They turn green as they arrive.`,
        "info",
      );
      setSelection(new Set());
      setFast(true);
    } catch (error) {
      toast.show(errorMessage(error), "error");
    }
  };

  // The keyboard shortcuts (S7.6), for the whole page.
  const handlers = useRef({ go, goToDo, help: () => setHelp(true) });
  handlers.current = { go, goToDo, help: () => setHelp(true) };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (document.querySelector("dialog[open]")) return;
      const active = document.activeElement;
      const action = shortcutFor(event, isTextInput(active));
      if (!action) return;
      const inPanel = active?.closest(".pane-panel") !== null;
      // Typing in another text input (the search, say): its keys are its own.
      const inOtherInput = isTextInput(active) && !active?.hasAttribute("data-translation-input");
      // Only a shortcut that did something takes the key from the browser.
      let handled = true;
      switch (action.type) {
        case "save":
          if (!panel.current) return;
          panel.current.saveAndNext();
          break;
        case "next":
        case "previous":
          handlers.current.go(action.type === "next" ? 1 : -1, inPanel);
          break;
        case "nextToDo":
        case "previousToDo":
          handlers.current.goToDo(action.type === "nextToDo" ? 1 : -1, inPanel);
          break;
        case "copySource":
          if (!panel.current || inOtherInput) return;
          handled = panel.current.copySource();
          break;
        case "takeLlmSuggestion":
          if (!panel.current || inOtherInput) return;
          handled = panel.current.takeLlmSuggestion();
          break;
        case "insert":
          if (!panel.current || inOtherInput) return;
          handled = panel.current.insertChip(action.index);
          break;
        case "help":
          handlers.current.help();
          break;
      }
      if (handled) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const tree = useMemo(() => buildTree(files.data?.files ?? []), [files.data]);
  const fileProgress = file ? files.data?.files.find((f) => f.path === file) : undefined;
  const summary = list.strings.find((s) => s.id === id);

  if (project.data && !language) {
    return (
      <NotFound
        title={`No language “${params.lang}”`}
        message="This project doesn't translate into that language."
      />
    );
  }
  // The address spells the tag differently (pt-br for pt-BR): use the project's spelling at
  // once, before anyone selects or types anything, since the editor's links use it and
  // another spelling is another page.
  if (language && !canonical) {
    return (
      <Redirect
        to={
          fillPattern("/translate/:lang", { lang: language.tag }) + location.search + location.hash
        }
      />
    );
  }

  const canApprove = tag !== null && session.can("edit", tag);
  const canTranslate = tag !== null && session.can("translate", tag);

  return (
    <div className="editor" data-mobile-pane={mobilePane}>
      <div className="editor-bar">
        <div className="editor-identity">
          <Link
            to={fillPattern("/languages/:lang", { lang: tag ?? params.lang })}
            className="editor-back"
          >
            <ArrowLeftIcon /> Language overview
          </Link>
          <H1 ui className="editor-title">
            Translate into {name}
            {language && <span className="heading-tag">{language.tag}</span>}
          </H1>
        </div>
        {language && (
          <div className="editor-progress">
            <ProgressBar progress={language} size="small" />
            <span className="muted small">{progressText(language)}</span>
          </div>
        )}
        <div className="editor-bar-end">
          <AutoTranslateButton language={tag ?? undefined} file={file} />
          <Button
            size="small"
            variant="ghost"
            icon={<KeyboardIcon />}
            onClick={() => setHelp(true)}
          >
            Shortcuts
          </Button>
        </div>
      </div>

      {project.error !== undefined && !project.data && (
        <ErrorMessage error={project.error} onRetry={() => project.refresh()} />
      )}
      {!project.data && project.error === undefined && <Loading label="Loading the editor…" />}

      {language && project.data && (
        <>
          <div className="editor-mobile-switch" role="group" aria-label="Editor view">
            <Button
              variant="plain"
              aria-pressed={mobilePane === "strings"}
              aria-controls="editor-strings"
              onClick={() => setMobilePane("strings")}
            >
              Strings <span className="muted">{formatNumber(list.total)}</span>
            </Button>
            <Button
              variant="plain"
              aria-pressed={mobilePane === "translation"}
              aria-controls="editor-translation"
              onClick={() => setMobilePane("translation")}
            >
              Translation
            </Button>
          </div>
          <div className="editor-panes">
            <nav
              id="editor-files"
              className={`pane pane-files${filesOpen ? " is-open" : ""}`}
              aria-label="Files"
              onKeyDown={(event) => {
                if (event.key === "Escape" && filesOpen) setFilesOpen(false);
              }}
              onBlur={(event) => {
                // Close before the drawer can hide the next focused element.
                const next = event.relatedTarget as Node | null;
                if (!filesOpen || !next || event.currentTarget.contains(next)) return;
                returnFocusFromFiles.current = false;
                setFilesOpen(false);
              }}
            >
              <div className="pane-title-row">
                <H2 ui className="pane-title">
                  Files
                </H2>
                <IconButton
                  className="files-close"
                  label="Close the files"
                  icon={<CloseIcon />}
                  onClick={() => setFilesOpen(false)}
                />
              </div>
              {files.error !== undefined && !files.data && (
                <ErrorMessage error={files.error} onRetry={() => files.refresh()} />
              )}
              {files.loading && <Loading label="Loading the files…" />}
              {files.data && (
                <FileTree
                  nodes={tree}
                  label="Files"
                  compact
                  selected={file ?? null}
                  onOpen={(path) => {
                    setQuery({ file: path, id: undefined });
                    setFilesOpen(false);
                  }}
                  hrefFor={(path) => href(editorPath, { file: path, state, q, order })}
                  before={
                    <Button
                      type="button"
                      className={`tree-all${file ? "" : " is-selected"}`}
                      aria-pressed={!file}
                      onClick={() => {
                        setQuery({ file: undefined, id: undefined });
                        setFilesOpen(false);
                      }}
                    >
                      All files
                    </Button>
                  }
                />
              )}
            </nav>

            <section
              id="editor-strings"
              className="pane pane-strings"
              aria-labelledby="strings-title"
              onFocus={() => setMobilePane("strings")}
            >
              <div className="strings-heading">
                <H2 ui id="strings-title" className="pane-title">
                  Strings
                  {file && (
                    <>
                      {" "}
                      <span className="muted">in {file}</span>
                    </>
                  )}
                </H2>
              </div>
              <StringList
                list={list}
                scope={
                  <Button
                    size="small"
                    variant="ghost"
                    id="files-toggle"
                    className="files-toggle"
                    icon={<FileIcon />}
                    aria-expanded={filesOpen}
                    aria-controls="editor-files"
                    aria-label={file ? `Choose file: ${file}` : "Choose a file"}
                    onClick={() => setFilesOpen(!filesOpen)}
                  >
                    <span>{file ? file.split("/").at(-1) : "All files"}</span>
                  </Button>
                }
                sourceLanguage={project.data.sourceLanguage}
                language={language.tag}
                syntax={project.data.syntax}
                progress={fileProgress ?? language}
                file={file}
                state={state}
                order={order}
                onOrder={(order) => setQuery({ order, id: undefined })}
                queue={
                  list.toDoIds
                    ? {
                        counter: queueCounter(list.toDoIds, list.strings, id, list.queueLoaded),
                        previous: () => goToDo(-1, false),
                        next: () => goToDo(1, false),
                      }
                    : undefined
                }
                search={q ?? ""}
                onSearch={(text) => setQuery({ q: text || undefined })}
                onState={(filter) => setQuery({ state: filter })}
                selectedId={id}
                hrefFor={hrefFor}
                onOpen={() => {
                  setMobilePane("translation");
                  const narrow = window.matchMedia("(max-width: 44rem)").matches;
                  setFocusPanel(narrow);
                  if (narrow) {
                    requestAnimationFrame(() => {
                      panel.current?.focusInput();
                      if (!document.activeElement?.closest(".pane-panel")) {
                        document.getElementById("panel-heading")?.focus();
                      }
                    });
                  }
                }}
                selection={selection}
                onSelection={setSelection}
                bulk={{
                  approve: canApprove,
                  translate: canTranslate,
                  llmAvailable: project.data.llmAvailable,
                  onApprove: bulkApprove,
                  onTranslate: bulkTranslate,
                }}
              />
            </section>

            <section
              id="editor-translation"
              className="pane pane-panel"
              aria-label="Translation"
              onFocus={() => setMobilePane("translation")}
            >
              <div className="editor-string-navigation" role="group" aria-label="String navigation">
                <Button
                  size="small"
                  variant="ghost"
                  icon={<ArrowLeftIcon />}
                  disabled={selectedIndex === 0 || list.strings.length === 0}
                  title="Alt+↑"
                  onClick={() => go(-1, true)}
                >
                  Previous
                </Button>
                <span className="muted small">
                  {selectedIndex >= 0
                    ? `${formatNumber(selectedIndex + 1)} of ${formatNumber(list.total)}`
                    : "Selected string"}
                </span>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={
                    list.strings.length === 0 ||
                    (!list.hasMore && selectedIndex === list.strings.length - 1)
                  }
                  title="Alt+↓"
                  onClick={() => go(1, true)}
                >
                  Next <ChevronRightIcon />
                </Button>
              </div>
              <div className="translation-workspace">
                {id === null ? (
                  list.strings.length === 0 && !list.loading ? (
                    <EmptyState title="No string selected" />
                  ) : (
                    <Loading />
                  )
                ) : (
                  <>
                    <TranslationPanel
                      ref={panel}
                      id={id}
                      language={language}
                      project={project.data}
                      summary={summary}
                      onNext={() => handlers.current.goToDo(1, true)}
                      onChanged={onChanged}
                      onJobStarted={() => setFast(true)}
                      autoFocus={focusPanel}
                    />
                    <DetailTabs
                      id={id}
                      language={language.tag}
                      tab={tab}
                      onTab={setTab}
                      onChanged={onChanged}
                      sourceLanguage={project.data.sourceLanguage}
                    />
                  </>
                )}
              </div>
            </section>
          </div>
        </>
      )}
      <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

/** The tabs under the panel, sharing the panel's request for the string's details. */
function DetailTabs({
  id,
  language,
  tab,
  onTab,
  onChanged,
  sourceLanguage,
}: {
  id: number;
  language: string;
  tab: SideTab;
  onTab(tab: SideTab): void;
  onChanged(ids: number[]): Promise<void>;
  sourceLanguage: string;
}) {
  const detail = useQuery<StringDetail>(
    stringKey(id, language),
    ({ fresh }) => getString(id, language, { fresh }),
    { staleTime: 5_000 },
  );
  if (!detail.data) return null;
  return (
    <div className="panel-tabs">
      <H2 ui className="panel-tabs-title">
        Context & review
      </H2>
      <SideTabs
        detail={detail.data}
        tab={tab}
        onTab={onTab}
        onChanged={onChanged}
        sourceLanguage={sourceLanguage}
      />
    </div>
  );
}
