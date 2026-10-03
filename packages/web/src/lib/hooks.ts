// SPDX-License-Identifier: MIT
/** Small React hooks shared by the pages. */
import { useEffect, useState } from "react";
import { useQuery } from "./data.ts";
import { getProject } from "./api.ts";
import type { ProjectInfo } from "@quaso/core";

export const PROJECT_KEY = ["project"] as const;

/** The project, its languages and their progress; polled while a page shows it. */
export function useProject(refreshInterval?: number) {
  return useQuery<ProjectInfo>(PROJECT_KEY, (context) => getProject(context), { refreshInterval });
}

/** Sets the document's title: "Page · Project". */
export function useDocumentTitle(...parts: (string | null | undefined)[]): void {
  const { data } = useProject();
  const title = [...parts, data?.name ?? "Quaso"].filter(Boolean).join(" · ");
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** The value, once it has stopped changing for `delay` milliseconds. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const LAST_LANGUAGE = "quaso:last-language";
let rememberedLanguage: string | null = null;

/** Storage may be unavailable; the in-memory choice still follows navigation. */
export function useRememberLanguage(tag: string | null | undefined): void {
  useEffect(() => {
    if (!tag) return;
    rememberedLanguage = tag;
    try {
      globalThis.localStorage?.setItem(LAST_LANGUAGE, tag);
    } catch {
      // Private windows may disable storage.
    }
  }, [tag]);
}

export function preferredLanguage(tags: readonly string[]): string | undefined {
  let preferred = rememberedLanguage;
  try {
    preferred ??= globalThis.localStorage?.getItem(LAST_LANGUAGE) ?? null;
  } catch {
    // The first available language remains usable without storage.
  }
  return tags.find((tag) => tag === preferred) ?? tags[0];
}
