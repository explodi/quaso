// SPDX-License-Identifier: MIT
/** A text area that grows with its content. */
import { type Ref, type TextareaHTMLAttributes, useCallback, useLayoutEffect, useRef } from "react";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
  autoGrow?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({
  minRows = 2,
  autoGrow = true,
  ref,
  value,
  className,
  onInput,
  ...rest
}: TextAreaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inner.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );

  const resize = useCallback(() => {
    const element = inner.current;
    if (!element || !autoGrow) return;
    element.style.height = "auto";
    const border = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + border}px`;
  }, [autoGrow]);

  useLayoutEffect(resize, [value, resize]);

  return (
    <textarea
      ref={setRef}
      rows={minRows}
      value={value}
      className={className ? `textarea ${className}` : "textarea"}
      {...rest}
      onInput={(event) => {
        resize();
        onInput?.(event);
      }}
    />
  );
}
