// SPDX-License-Identifier: MIT
/**
 * A windowed list of our own (design §5.9: thousands of strings stay fast): rows of a fixed
 * height, only those in view (plus some overscan) in the page. The keyboard moves between
 * rows with ↑, ↓, Home, End, Page Up and Page Down; focus goes to the row's element marked
 * `data-row-focus`, and only the active row is in the Tab order (a roving tab index).
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  /** Rows rendered beyond the visible ones, on each side. */
  overscan?: number;
  /** The row's content; `active` says whether it holds the tab stop. */
  renderRow(index: number, active: boolean): ReactNode;
  rowKey(index: number): string | number;
  /** The row that holds the tab stop. */
  activeIndex: number;
  onActiveIndexChange(index: number): void;
  /** Called when the last rows come into view, to load more. */
  onEndReached?(): void;
  /** The list's accessible name. */
  label: string;
  /** The total number of items, when more than `count` are known to exist. */
  setSize?: number;
  className?: string;
}

export function VirtualList(props: VirtualListProps) {
  const { count, rowHeight, overscan = 6, activeIndex, onActiveIndexChange, onEndReached } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const focusRequest = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    setHeight(element.clientHeight || 600);
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 600));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  useEffect(() => {
    if (onEndReached && count > 0 && last >= count - 1 - overscan) onEndReached();
  }, [last, count, overscan, onEndReached]);

  /** Scrolls so the row is fully visible. */
  const reveal = useCallback(
    (index: number) => {
      const element = scroller.current;
      if (!element) return;
      const top = index * rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + rowHeight - element.clientHeight;
      }
      setScrollTop(element.scrollTop);
    },
    [rowHeight],
  );

  // Keep the active row in view when it changes from outside (the next string, say).
  // (Not when more rows load: that would pull the reader back from the end of the list.)
  useEffect(() => {
    if (activeIndex >= 0) reveal(activeIndex);
  }, [activeIndex, reveal]);

  // After moving with the keyboard, focus the new row once it is rendered.
  useEffect(() => {
    const index = focusRequest.current;
    if (index === null) return;
    focusRequest.current = null;
    scroller.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"] [data-row-focus]`)
      ?.focus({ preventScroll: true });
  });

  const move = (index: number) => {
    const target = Math.max(0, Math.min(count - 1, index));
    focusRequest.current = target;
    reveal(target);
    onActiveIndexChange(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || count === 0) return;
    const page = Math.max(1, Math.floor(height / rowHeight) - 1);
    const keys: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      Home: 0,
      End: count - 1,
      PageDown: activeIndex + page,
      PageUp: activeIndex - page,
    };
    const target = keys[event.key];
    if (target === undefined) return;
    // Leave the keys to text fields inside rows, if any.
    if (event.target instanceof HTMLInputElement && event.target.type === "text") return;
    event.preventDefault();
    move(target);
  };

  const rows: number[] = [];
  for (let i = first; i <= last; i++) rows.push(i);
  // The active row stays in the page even when scrolled away, so focus isn't lost.
  if (activeIndex >= 0 && activeIndex < count && (activeIndex < first || activeIndex > last)) {
    rows.push(activeIndex);
  }

  return (
    <div
      ref={scroller}
      className={props.className ? `vlist ${props.className}` : "vlist"}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div
        role="list"
        aria-label={props.label}
        className="vlist-inner"
        style={{ height: `${count * rowHeight}px` }}
      >
        {rows.map((index) => (
          <div
            key={props.rowKey(index)}
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={props.setSize ?? count}
            data-index={index}
            className="vlist-row"
            style={{ transform: `translateY(${index * rowHeight}px)`, height: `${rowHeight}px` }}
          >
            {props.renderRow(index, index === activeIndex)}
          </div>
        ))}
      </div>
    </div>
  );
}
