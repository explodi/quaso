// SPDX-License-Identifier: MIT
/** Download baselines distinguish repository edits from later changes on the instance. */
import { formatKeyPath, type KeyPath } from "@quaso/core";
import type { Project } from "./config.ts";
import { usageError } from "./errors.ts";
import { absolutePath, type Sources } from "./files.ts";
import { readProjectText, RealPathGuard, utf8, writeAtomic } from "./fs.ts";

const STATE_PATH = ".quaso/download-state";
const decoder = new TextDecoder("utf-8", { fatal: true });

export class DownloadState {
  private changed = false;
  private constructor(
    private project: Project,
    private server: string,
    private files: Record<string, string>,
  ) {}

  static async load(project: Project, sources: Sources, server: string): Promise<DownloadState> {
    await new RealPathGuard(project, sources).check(STATE_PATH, "download state");
    const text = await readProjectText(project, STATE_PATH);
    if (text === null) return new DownloadState(project, server, {});
    try {
      const state = JSON.parse(text);
      const valid =
        state.version === 1 &&
        state.files !== null &&
        typeof state.files === "object" &&
        !Array.isArray(state.files);
      if (!valid || !Object.values(state.files).every((value) => typeof value === "string"))
        throw new Error();
      return new DownloadState(project, server, state.files);
    } catch {
      throw usageError(`Can't read ${STATE_PATH}: the download baseline is invalid.`, {
        hint: "Keep a copy of the file and restore a valid baseline before downloading.",
      });
    }
  }

  conflicts(path: string, local: Uint8Array, incoming: Uint8Array, source: string): string[] {
    try {
      const current = leafValues(decoder.decode(local));
      const next = leafValues(decoder.decode(incoming));
      const previous = this.files[this.key(path)];
      const known = leafValues(previous ?? source);
      const keys = new Set([...current.keys(), ...next.keys(), ...known.keys()]);
      const conflicts: string[] = [];
      for (const key of keys) {
        const value = current.get(key);
        const alreadyIncoming = value === next.get(key);
        const unchangedLocally = value === known.get(key);
        if (alreadyIncoming || unchangedLocally) continue;
        conflicts.push(formatKeyPath(JSON.parse(key)) || "(root)");
      }
      return conflicts;
    } catch {
      return ["(invalid JSON)"];
    }
  }

  remember(path: string, bytes: Uint8Array): void {
    const text = decoder.decode(bytes);
    const key = this.key(path);
    if (this.files[key] === text) return;
    this.files[key] = text;
    this.changed = true;
  }

  async save(): Promise<void> {
    if (!this.changed) return;
    await writeAtomic(
      absolutePath(this.project, STATE_PATH),
      utf8(JSON.stringify({ version: 1, files: this.files }) + "\n"),
    );
  }

  private key(path: string): string {
    return JSON.stringify([this.server, path]);
  }
}

function leafValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  function visit(value: unknown, path: KeyPath) {
    if (value !== null && typeof value === "object" && Object.keys(value).length > 0) {
      for (const [key, child] of Object.entries(value))
        visit(child, [...path, Array.isArray(value) ? Number(key) : key]);
      return;
    }
    values.set(JSON.stringify(path), JSON.stringify(value));
  }
  visit(JSON.parse(text), []);
  return values;
}
