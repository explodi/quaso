// SPDX-License-Identifier: MIT
/**
 * Toasts: short messages after an action ("Saved"), announced politely to screen readers
 * (the region is always in the page, so additions are heard).
 *
 * Success and information toasts go after a while, but not while the pointer is over them
 * or focus is in them (WCAG 2.2.1); errors stay until dismissed unless given a duration,
 * so their details can be
 * read at any pace. When a toast that has focus goes, focus returns to where it was before
 * it entered the toasts (WCAG 2.4.3).
 */
import {
  createContext,
  type FocusEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { focusMainHeading } from "../lib/router.tsx";
import { Link } from "../lib/router.tsx";
import { IconButton, CheckIcon, CloseIcon, InfoIcon, WarningIcon } from "@quaso/design-system";

export type ToastKind = "success" | "error" | "info";

/** How long a success or information toast stays, without hover or focus. */
export const TOAST_DURATION = 5_000;

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  duration?: number;
  link?: { to: string; label: string };
}

interface Toaster {
  show(
    message: string,
    kind?: ToastKind,
    options?: { duration?: number; link?: Toast["link"] },
  ): void;
  region: HTMLElement | null;
}

const ToastContext = createContext<Toaster>({ show() {}, region: null });

export function useToast(): Toaster {
  return useContext(ToastContext);
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss(id: number): void }) {
  const [paused, setPaused] = useState({ hover: false, focus: false });
  const remaining = useRef(toast.duration ?? TOAST_DURATION);

  // Counts down only while nobody is looking at it with the pointer or the keyboard.
  useEffect(() => {
    const persistent = toast.kind === "error" && toast.duration === undefined;
    if (persistent || paused.hover || paused.focus) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(1_000, remaining.current - (Date.now() - started));
    };
  }, [toast, paused.hover, paused.focus, onDismiss]);

  return (
    <div
      className={`toast toast-${toast.kind}`}
      data-toast={toast.id}
      onMouseEnter={() => setPaused((p) => ({ ...p, hover: true }))}
      onMouseLeave={() => setPaused((p) => ({ ...p, hover: false }))}
      onFocus={() => setPaused((p) => ({ ...p, focus: true }))}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused((p) => ({ ...p, focus: false }));
        }
      }}
    >
      {toast.kind === "success" ? (
        <CheckIcon className="toast-icon" />
      ) : toast.kind === "error" ? (
        <WarningIcon className="toast-icon" />
      ) : (
        <InfoIcon className="toast-icon" />
      )}
      <span className="toast-message">
        {toast.message}
        {toast.link && (
          <>
            {" "}
            <Link to={toast.link.to}>{toast.link.label}</Link>
          </>
        )}
      </span>
      <IconButton
        label="Dismiss"
        icon={<CloseIcon size={14} />}
        onClick={() => onDismiss(toast.id)}
      />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const region = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const attachRegion = useCallback((element: HTMLDivElement | null) => {
    region.current = element;
    setContainer(element);
  }, []);
  /** Where focus was before it went into the toasts. */
  const returnTo = useRef<HTMLElement | null>(null);

  const dismiss = useCallback((id: number) => {
    const element = region.current?.querySelector(`[data-toast="${id}"]`);
    const hadFocus = element?.contains(document.activeElement) ?? false;
    setToasts((current) => current.filter((toast) => toast.id !== id));
    if (hadFocus) {
      requestAnimationFrame(() => {
        const target = returnTo.current;
        if (target?.isConnected && !region.current?.contains(target)) target.focus();
        if (document.activeElement === target) return;
        // Somewhere sensible that still exists: another toast, or the page's heading.
        const other = region.current?.querySelector<HTMLElement>("button");
        if (other) other.focus();
        else focusMainHeading();
      });
    }
  }, []);

  const show = useCallback(
    (
      message: string,
      kind: ToastKind = "success",
      options: { duration?: number; link?: Toast["link"] } = {},
    ) => {
      const id = next.current++;
      setToasts((current) => [...current.slice(-3), { id, message, kind, ...options }]);
    },
    [],
  );

  const value = useMemo(() => ({ show, region: container }), [show, container]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        ref={attachRegion}
        className="toasts"
        role="status"
        aria-live="polite"
        aria-relevant="additions"
        onFocus={(event) => {
          const from = event.relatedTarget as HTMLElement | null;
          if (from && !event.currentTarget.contains(from)) returnTo.current = from;
        }}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
