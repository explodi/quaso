// SPDX-License-Identifier: MIT
import { Label, Checkbox, Input, Fieldset, Radio, Select } from "../../components/Controls.tsx";
/**
 * The editor's middle pane (design §5.9, S7.5): the strings, virtualized, each with its
 * state marker, its English (placeholders highlighted) and its key; filters by state,
 * search by key or text, and selecting several strings (checkboxes, Shift-click for a
 * range) for bulk actions.
 */
import {
  type InterpolationSyntax,
  type Progress,
  STATE_FILTERS,
  type StateFilter,
  textDirection,
} from "@quaso/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import {
  CheckSquareIcon,
  ClockIcon,
  EmptySquareIcon,
  HalfSquareIcon,
  HourglassIcon,
  SearchIcon,
  SparklesIcon,
  WarningIcon,
} from "../../components/Icons.tsx";
import { SourceText } from "../../components/SourceText.tsx";
import { Loading } from "../../components/Spinner.tsx";
import { StateMarker } from "../../components/StateBadge.tsx";
import { VirtualList } from "../../components/VirtualList.tsx";
import { count, formatNumber, sourcePreview } from "../../lib/format.ts";
import { useDebounced } from "../../lib/hooks.ts";
import { Link } from "../../lib/router.tsx";
import { FILTER_LABELS, filterCount } from "../../lib/states.ts";
import type { StringList as List } from "./useStringList.ts";

const ROW_HEIGHT = 60;
/** The API's longest search (`q`). */
export const SEARCH_MAX_LENGTH = 200;

const FILTER_ICONS: Record<StateFilter, ReactNode> = {
  untranslated: <EmptySquareIcon className="state-red" />,
  green: <HalfSquareIcon className="state-green" />,
  blue: <CheckSquareIcon className="state-blue" />,
  outdated: <ClockIcon className="flag-outdated" />,
  pending: <HourglassIcon className="flag-pending" />,
  qa: <WarningIcon className="flag-qa" />,
};

export interface BulkActions {
  approve: boolean;
  translate: boolean;
  llmAvailable: boolean;
  onApprove(ids: number[]): Promise<void>;
  onTranslate(ids: number[]): Promise<void>;
}

export interface StringListProps {
  list: List;
  sourceLanguage: string;
  syntax: InterpolationSyntax;
  /** Progress of what the filters apply to (the file, or the language), for the counts. */
  progress?: Progress;
  file?: string;
  state?: StateFilter;
  order: "queue" | "file";
  onOrder(order: "queue" | "file"): void;
  queue?: { counter: string; previous(): void; next(): void };
  search: string;
  onSearch(q: string): void;
  onState(state: StateFilter | undefined): void;
  selectedId: number | null;
  hrefFor(id: number): string;
  onOpen(id: number): void;
  selection: Set<number>;
  onSelection(selection: Set<number>): void;
  bulk: BulkActions;
}

export function StringList(props: StringListProps) {
  const { list, selection, onSelection, bulk } = props;
  const [search, setSearch] = useState(props.search);
  const debounced = useDebounced(search, 300);
  const [focusState, setFocusState] = useState<{ selected: number | null; index: number } | null>(
    null,
  );
  const lastToggled = useRef<number | null>(null);
  const [busy, setBusy] = useState<"approve" | "translate" | null>(null);
  const canBulk = bulk.approve || bulk.translate;

  const onSearch = props.onSearch;
  // Search once the typed text settles.
  useEffect(() => {
    if (debounced !== props.search) onSearch(debounced);
  }, [debounced]);

  // The selected string holds the list's tab stop.
  const selectedIndex = list.strings.findIndex((s) => s.id === props.selectedId);
  const activeIndex =
    focusState?.selected === props.selectedId ? focusState.index : Math.max(0, selectedIndex);
  const setActiveIndex = (index: number) => setFocusState({ selected: props.selectedId, index });
  const active = Math.min(activeIndex, Math.max(0, list.strings.length - 1));

  // Moving to another string with the keyboard (Alt+↓) while in the list: focus follows.
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      selectedIndex < 0 ||
      !container.current?.querySelector(".vlist")?.contains(document.activeElement)
    ) {
      return;
    }
    requestAnimationFrame(() =>
      container.current
        ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"] [data-row-focus]`)
        ?.focus({ preventScroll: true }),
    );
  }, [selectedIndex]);

  const toggle = (index: number, checked: boolean, range: boolean) => {
    const next = new Set(selection);
    const from =
      range && lastToggled.current !== null ? Math.min(lastToggled.current, index) : index;
    const to = range && lastToggled.current !== null ? Math.max(lastToggled.current, index) : index;
    for (let i = from; i <= to; i++) {
      const id = list.strings[i]?.id;
      if (id === undefined) continue;
      if (checked) next.add(id);
      else next.delete(id);
    }
    lastToggled.current = index;
    onSelection(next);
  };

  const loadedIds = list.strings.map((s) => s.id);
  const allChecked = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));
  const someChecked = !allChecked && loadedIds.some((id) => selection.has(id));

  const run = async (kind: "approve" | "translate") => {
    const hadFocus = container.current?.contains(document.activeElement) ?? false;
    setBusy(kind);
    try {
      const ids = [...selection];
      if (kind === "approve") await bulk.onApprove(ids);
      else await bulk.onTranslate(ids);
    } finally {
      setBusy(null);
      // Done, the selection is cleared and the bar with its buttons goes: focus goes to the
      // list's current row rather than dropping to the page's body (WCAG 2.4.3).
      if (hadFocus) {
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && active !== document.body && active.isConnected) return;
          (
            container.current?.querySelector<HTMLElement>('[data-row-focus][tabindex="0"]') ??
            container.current?.querySelector<HTMLElement>("#string-search")
          )?.focus();
        });
      }
    }
  };

  const sourceDirection = textDirection(props.sourceLanguage);

  const renderRow = (index: number, isActive: boolean) => {
    const summary = list.strings[index];
    if (!summary) return null;
    const current = summary.id === props.selectedId;
    const checked = selection.has(summary.id);
    return (
      <div className={`string-row${current ? " is-current" : ""}${checked ? " is-checked" : ""}`}>
        {canBulk && (
          // The label makes the whole strip beside the row a target of at least 24×24 px,
          // clear of the row's link (WCAG 2.5.8).
          <Label className="row-check-target">
            <Checkbox
              className="row-check"
              checked={checked}
              tabIndex={isActive ? 0 : -1}
              aria-label={`Select ${summary.key}`}
              onChange={() => {}}
              onClick={(event) => toggle(index, event.currentTarget.checked, event.shiftKey)}
            />
          </Label>
        )}
        <Link
          to={props.hrefFor(summary.id)}
          replace
          quiet
          className="row-link"
          data-row-focus=""
          tabIndex={isActive ? 0 : -1}
          aria-current={current ? "true" : undefined}
          onFocus={() => setActiveIndex(index)}
          onClick={() => props.onOpen(summary.id)}
          onKeyDown={(event) => {
            if (event.key === " " && canBulk) {
              event.preventDefault();
              toggle(index, !checked, event.shiftKey);
            }
          }}
        >
          <StateMarker summary={summary} />
          <span className="row-text">
            <span className="row-source" lang={props.sourceLanguage} dir={sourceDirection}>
              <SourceText text={sourcePreview(summary.source)} syntax={props.syntax} />
            </span>
            <span className="row-key">
              <code>{summary.key}</code>
              {summary.kind !== "text" && <span className="row-kind">{summary.kind}</span>}
              {!props.file && <span className="row-file">{summary.file}</span>}
            </span>
          </span>
        </Link>
      </div>
    );
  };

  const filters: (StateFilter | undefined)[] = [undefined, ...STATE_FILTERS];

  return (
    <div className="strings-pane-body" ref={container}>
      <div className="strings-tools">
        <div className="search">
          <SearchIcon className="search-icon" />
          <Label htmlFor="string-search" className="sr-only">
            Search strings by key or text
          </Label>
          <Input
            id="string-search"
            className="search-input"
            type="search"
            placeholder="Search by key or text"
            maxLength={SEARCH_MAX_LENGTH}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSearch(search);
            }}
          />
        </div>
        <Fieldset className="state-filter">
          <legend className="sr-only">Show strings</legend>
          {filters.map((filter) => {
            const checked = props.state === filter;
            const n =
              filter && props.progress
                ? filterCount(props.progress, filter)
                : props.progress?.strings;
            return (
              <Label key={filter ?? "all"} className={`filter-chip${checked ? " is-checked" : ""}`}>
                <Radio
                  name="state-filter"
                  className="visually-hidden-input"
                  checked={checked}
                  onChange={() => props.onState(filter)}
                />
                <span className="filter-chip-body">
                  {filter ? FILTER_ICONS[filter] : null}
                  {filter ? FILTER_LABELS[filter] : "All"}
                  {n !== undefined && (
                    <>
                      {" "}
                      <span className="filter-count">{formatNumber(n)}</span>
                    </>
                  )}
                </span>
              </Label>
            );
          })}
        </Fieldset>
      </div>
      <div className="strings-order">
        <Label>
          Order
          <Select
            value={props.order}
            onChange={(event) => props.onOrder(event.target.value === "file" ? "file" : "queue")}
          >
            <option value="queue">To do first</option>
            <option value="file">File order</option>
          </Select>
        </Label>
        {props.queue && (
          <div className="queue-navigation" aria-label="Translation queue">
            <Button size="small" variant="ghost" onClick={props.queue.previous}>
              Previous to do
            </Button>
            <span role="status">{props.queue.counter}</span>
            <Button size="small" variant="ghost" onClick={props.queue.next}>
              Next to do
            </Button>
          </div>
        )}
      </div>
      <div className="strings-status">
        {canBulk && (
          <Label className="checkbox select-all">
            <Checkbox
              checked={allChecked}
              ref={(element) => {
                if (element) element.indeterminate = someChecked;
              }}
              onChange={(event) =>
                onSelection(event.target.checked ? new Set(loadedIds) : new Set())
              }
              disabled={loadedIds.length === 0}
            />
            <span className="sr-only">Select every loaded string</span>
          </Label>
        )}
        <p className="muted" aria-live="polite">
          {list.loading
            ? "Loading strings…"
            : list.error !== undefined && list.strings.length === 0
              ? "The strings couldn't be loaded."
              : count(list.total, "string")}
          {list.previous && " (updating…)"}
        </p>
      </div>
      {canBulk && selection.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected strings">
          <span>{count(selection.size, "string")} selected</span>
          {bulk.approve && (
            <Button
              size="small"
              busy={busy === "approve"}
              onClick={() => run("approve")}
              icon={<CheckSquareIcon />}
            >
              Approve
            </Button>
          )}
          {bulk.translate && (
            <Button
              size="small"
              busy={busy === "translate"}
              disabled={!bulk.llmAvailable}
              onClick={() => run("translate")}
              icon={<SparklesIcon />}
              aria-describedby={bulk.llmAvailable ? undefined : "bulk-llm-off"}
            >
              Translate with the LLM
            </Button>
          )}
          <Button size="small" variant="ghost" onClick={() => onSelection(new Set())}>
            Clear
          </Button>
          {bulk.translate && !bulk.llmAvailable && (
            <p id="bulk-llm-off" className="bulk-note">
              LLM translation is off: this server has no LLM provider.
            </p>
          )}
        </div>
      )}
      {list.error !== undefined && list.strings.length === 0 && (
        <ErrorMessage error={list.error} onRetry={list.retry} />
      )}
      {list.loading && <Loading label="Loading strings…" />}
      {!list.loading && list.error === undefined && list.strings.length === 0 && (
        <EmptyState title="No strings here">
          <p>
            {props.state || props.search
              ? "No string matches the filters."
              : "This file has no strings."}
          </p>
        </EmptyState>
      )}
      {list.strings.length > 0 && (
        <VirtualList
          count={list.strings.length}
          setSize={list.total}
          rowHeight={ROW_HEIGHT}
          rowKey={(index) => list.strings[index]?.id ?? index}
          renderRow={renderRow}
          activeIndex={active}
          onActiveIndexChange={setActiveIndex}
          onEndReached={list.hasMore ? () => void list.loadMore().catch(() => {}) : undefined}
          label="Strings"
          className="string-list"
        />
      )}
    </div>
  );
}
