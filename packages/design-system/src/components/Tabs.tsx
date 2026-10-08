// SPDX-License-Identifier: MIT
import { Button } from "./Button.tsx";
/**
 * Tabs, following the WAI-ARIA tabs pattern: the arrow keys, Home and End move between tabs
 * (and select them); Tab moves into the panel.
 */
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
}

export function Tabs({
  tabs,
  selected,
  onSelect,
  label,
  children,
}: {
  tabs: TabItem[];
  selected: string;
  onSelect(id: string): void;
  /** The tab list's accessible name. */
  label: string;
  /** The selected tab's panel. */
  children: ReactNode;
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === selected),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tab-list" ref={list} onKeyDown={onKeyDown}>
        {tabs.map((tab, i) => (
          <Button
            variant="plain"
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={i === index}
            aria-controls={`${base}-panel`}
            tabIndex={i === index ? 0 : -1}
            className="tab"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${tabs[index]?.id}`}
        tabIndex={0}
        className="tab-panel"
      >
        {children}
      </div>
    </div>
  );
}
