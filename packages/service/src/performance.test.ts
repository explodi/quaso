// SPDX-License-Identifier: MIT
import { test } from "node:test";
/**
 * OPS-1 and PROD-4 (design §8, S2.11): upload and download of 3,000 strings in 10 languages
 * take well under 2 seconds each. The 50,000-string smoke test in 30 languages guards
 * against anything quadratic; it runs only with `QUASO_SMOKE=1`, and reports its times.
 */
import { assert } from "@quaso/runtime/assert";
import type { UploadRequest } from "@quaso/core";
import { SYSTEM } from "./api.ts";
import { startTestService, type TestInstance } from "./test_helpers.ts";

const TEN_LANGUAGES = ["de", "fr", "es", "it", "pt-BR", "pl", "ru", "ja", "ko", "zh-Hans"];
const THIRTY_LANGUAGES = [
  ...TEN_LANGUAGES,
  ...["nl", "sv", "da", "fi", "nb", "cs", "sk", "hu", "ro", "bg"],
  ...["uk", "tr", "el", "he", "ar", "th", "vi", "id", "ms", "hi"],
];

/**
 * A synthetic project: `files` files of `perFile` strings, in nested objects of 10 keys,
 * with a plural group every 10th string, placeholders and a few references. `version`
 * changes the English of every 10th string, and `shift` adds a key at the top of each file.
 */
function synthetic(
  files: number,
  perFile: number,
  options: { version?: number; shift?: boolean } = {},
): UploadRequest["files"] {
  const out: UploadRequest["files"] = [];
  for (let f = 0; f < files; f++) {
    const root: Record<string, Record<string, string | number>> = {};
    if (options.shift) root.added = { first: "A new string at the top" };
    for (let i = 0; i < perFile; i++) {
      const group = (root[`section${Math.floor(i / 10)}`] ??= {});
      const edited = options.version !== undefined && i % 10 === 3 ? ` (v${options.version})` : "";
      if (i % 10 === 0) {
        group[`item${i}_one`] = `{{count}} item in slot ${i}${edited}`;
        group[`item${i}_other`] = `{{count}} items in slot ${i}${edited}`;
      } else if (i % 50 === 7) {
        group[`item${i}`] = `$t(section0.item1) and more`;
      } else if (i % 100 === 9) {
        group[`item${i}`] = i;
      } else {
        group[`item${i}`] = `The quick brown fox number ${i} jumps over {{name}}${edited}.`;
      }
    }
    out.push({
      path: `file${f}.json`,
      repoPath: `file${f}.json`,
      content: `${JSON.stringify(root, null, 2)}\n`,
    });
  }
  return out;
}

/** Translations of every translatable string in every language, written in one statement. */
function translateEverything(instance: TestInstance): void {
  instance.sql.run(
    `INSERT INTO translations (string_id, language, value, colour, source_hash, author_type,
       revision, search_text, created_at, updated_at)
     SELECT s.id, l.tag, s.source, 'green', s.source_hash, 'system', 1, s.search_text, 0, 0
     FROM strings s CROSS JOIN languages l WHERE s.kind IN ('text', 'plural', 'ordinal')`,
  );
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, performance.now() - start];
}

async function measure(files: number, perFile: number, languages: string[]) {
  using instance = await startTestService();
  const [first, uploadNew] = await time(() =>
    instance.service.upload(SYSTEM, { files: synthetic(files, perFile), languages }),
  );
  translateEverything(instance);
  const [second, uploadChanged] = await time(() =>
    instance.service.upload(SYSTEM, {
      files: synthetic(files, perFile, { version: 2, shift: true }),
    }),
  );
  const [unchanged, uploadSame] = await time(() =>
    instance.service.upload(SYSTEM, {
      files: synthetic(files, perFile, { version: 2, shift: true }),
    }),
  );
  const [exported, download] = await time(() => instance.service.exportFiles(SYSTEM, {}));
  const [, status] = await time(() => instance.service.getStatus(SYSTEM, {}));
  const [, project] = await time(() => instance.service.getProject(SYSTEM, {}));
  const [, list] = await time(() =>
    instance.service.listStrings(SYSTEM, { language: "de", state: "outdated", q: "fox" }),
  );
  return {
    counts: {
      added: first.added.length,
      changed: second.changed.length,
      unchangedUpload: unchanged.uploadId === null,
      exportedFiles: exported.files.length,
    },
    ms: { uploadNew, uploadChanged, uploadSame, download, status, project, list },
  };
}

test("3,000 strings in 10 languages: upload and download each take well under 2 seconds", async () => {
  const { counts, ms } = await measure(10, 300, TEN_LANGUAGES);
  assert(counts.added === 3000, `added ${counts.added}`);
  assert(counts.changed === 300, `changed ${counts.changed}`);
  assert(counts.unchangedUpload, "the same upload again changes nothing");
  assert(counts.exportedFiles === 100, `exported ${counts.exportedFiles}`);
  for (const [name, value] of Object.entries(ms)) {
    assert(value < 2000, `${name} took ${Math.round(value)} ms`);
  }
});

test("a length limit on each of 6,000 strings costs about as much as the strings", async () => {
  using instance = await startTestService();
  const english: Record<string, string> = {};
  for (let i = 0; i < 6000; i++) english[`key${i}`] = `Text number ${i}`;
  const files = [{ path: "store.json", repoPath: "store.json", content: JSON.stringify(english) }];
  await instance.service.upload(SYSTEM, { files, languages: TEN_LANGUAGES });
  const limits = Object.keys(english).map((key) => ({ file: "store.json", key, maxLength: 40 }));
  const [first, limited] = await time(() => instance.service.upload(SYSTEM, { files, limits }));
  const [again, same] = await time(() => instance.service.upload(SYSTEM, { files, limits }));
  assert(typeof first.uploadId === "number" && again.uploadId === null);
  assert(limited < 1000, `the upload with limits took ${Math.round(limited)} ms`);
  assert(same < 1000, `the same upload again took ${Math.round(same)} ms`);
});

test(
  "smoke: 50,000 strings in 30 languages (QUASO_SMOKE=1)",
  { skip: process.env["QUASO_SMOKE"] !== "1", timeout: 1200000 },
  async () => {
    const { counts, ms } = await measure(50, 1000, THIRTY_LANGUAGES);
    const rounded = Object.fromEntries(
      Object.entries(ms).map(([name, value]) => [name, Math.round(value)]),
    );
    console.log("50,000 strings in 30 languages:", counts, "times in ms:", rounded);
    assert(counts.added === 50_000);
  },
);
