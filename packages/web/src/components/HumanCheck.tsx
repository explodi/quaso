// SPDX-License-Identifier: MIT
/** Turnstile is loaded only when the server advertises a human check. */
import { useEffect, useRef, useState } from "react";
import { useSession } from "../lib/session.tsx";

interface Turnstile {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      callback(token: string): void;
      "expired-callback"(): void;
      "error-callback"(): void;
    },
  ): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<void> | undefined;
function load(): Promise<void> {
  if ((globalThis as typeof globalThis & { turnstile?: Turnstile }).turnstile) {
    return Promise.resolve();
  }
  return (loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(new Error("Human check could not load"));
    };
    document.head.append(script);
  }));
}

export function HumanCheck({ onToken }: { onToken(token: string): void }) {
  const check = useSession().info.humanCheck;
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!check) return;
    let disposed = false;
    let widget: string | undefined;
    load()
      .then(() => {
        const turnstile = (globalThis as typeof globalThis & { turnstile?: Turnstile }).turnstile;
        if (disposed || !container.current || !turnstile) return;
        widget = turnstile.render(container.current, {
          sitekey: check.siteKey,
          callback: (token) => callback.current(token),
          "expired-callback": () => callback.current(""),
          "error-callback": () => {
            setFailed(true);
            callback.current("");
          },
        });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (widget) {
        (globalThis as typeof globalThis & { turnstile?: Turnstile }).turnstile?.remove(widget);
      }
    };
  }, [check?.siteKey]);
  if (!check) return null;
  return (
    <div>
      <div ref={container} aria-label="Human verification" />
      {failed && (
        <p className="field-error" role="alert">
          The human check could not load. Check your connection and reload the page.
        </p>
      )}
    </div>
  );
}
