// SPDX-License-Identifier: MIT
import { H2 } from "./Typography.tsx";
/**
 * A modal dialog on the native `<dialog>` element: the rest of the page is inert while it is
 * open, Tab stays inside it, Escape closes it, and focus returns to where it was, or, when
 * that element is gone (the dialog deleted what opened it), to the owner's fallback.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "./Button.tsx";
import { CloseIcon } from "./Icons.tsx";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Focuses `element` if it is still in the page and can take focus; says whether it did. */
function tryFocus(element: HTMLElement | null | undefined): boolean {
  if (!element?.isConnected) return false;
  element.focus();
  return document.activeElement === element;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "medium",
  returnFocus,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "small" | "medium" | "large";
  /** Where focus goes when the element that opened the dialog is gone or disabled. */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;
  const titleId = useId();

  const giveFocusBack = () => {
    const target = returnTo.current;
    returnTo.current = null;
    if (!target || tryFocus(target)) return;
    tryFocus(fallback.current?.());
  };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      returnTo.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      element.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // Closing by unmounting still gives focus back.
  useEffect(() => () => giveFocusBack(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (item) => item.offsetParent !== null || item === document.activeElement,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialog}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: let the owner decide, so its state stays in charge.
        event.preventDefault();
        onClose();
      }}
      onClose={giveFocusBack}
      onKeyDown={onKeyDown}
    >
      {open && (
        <>
          <div className="dialog-header">
            <H2 id={titleId} className="dialog-title">
              {title}
            </H2>
            <IconButton label="Close" icon={<CloseIcon />} onClick={onClose} />
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
