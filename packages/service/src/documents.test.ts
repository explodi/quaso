// SPDX-License-Identifier: MIT
/** Markdown documents through the service: one string per file, translated whole. */
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { sha256Hex } from "@quaso/core";
import { SYSTEM } from "./api.ts";
import { ServiceError } from "./errors.ts";
import { drain, scriptedProvider } from "./jobs/testing.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { startTestService, type TestInstance, uploadJson, write } from "./test_helpers.ts";

const ARTICLE = [
  "The moment has arrived: {{cityName}} is founded",
  "",
  "What was once a patch of dirt is now a patch of dirt with a name: {{cityName}}.",
  "",
  "Some managed to hold it. Others will have a story to tell.",
].join("\n");

const GERMAN = [
  "Der Moment ist gekommen: {{cityName}} ist gegründet",
  "",
  "Was einst ein Stück Erde war, ist nun ein Stück Erde mit Namen: {{cityName}}.",
  "",
  "Manche hielten durch. Andere haben nun etwas zu erzählen.",
].join("\n");

const PATH = "news/city_founded.md";

function document(path: string, content: string) {
  return { path, repoPath: `text/en/${path}`, content };
}

/** A project with one JSON file and one Markdown document, in German and Polish. */
async function project(): Promise<TestInstance> {
  const instance = await startTestService();
  await instance.service.upload(SYSTEM, {
    files: [
      { path: "common.json", repoPath: "common.json", content: '{ "title": "Wayfarer" }\n' },
      document(PATH, `${ARTICLE}\n`),
    ],
    languages: ["de", "pl"],
  });
  return instance;
}

test("upload: a Markdown file is one document string, whose key is empty", async () => {
  using instance = await project();
  const files = await instance.service.listFiles(SYSTEM, {});
  assert(!("language" in files) || files.language === undefined);
  const stored = instance.sql.query<{ format: string }>(
    "SELECT format FROM files WHERE path = ?",
    PATH,
  );
  assertEquals(stored, [{ format: '{"type":"markdown"}' }]);
  const strings = await instance.service.listStrings(SYSTEM, { language: "de", file: PATH });
  assertEquals(strings.total, 1);
  const [summary] = strings.strings;
  assertEquals(
    {
      file: summary.file,
      key: summary.key,
      kind: summary.kind,
      document: summary.document,
      source: summary.source,
    },
    { file: PATH, key: "", kind: "text", document: true, source: ARTICLE },
  );
  assert(summary.words > 20, `${summary.words} words`);
  const json = await instance.service.listStrings(SYSTEM, { language: "de", file: "common.json" });
  assertEquals(json.strings[0].document, false);
});

test("upload: a blank Markdown file holds nothing to translate", async () => {
  using instance = await startTestService();
  await instance.service.upload(SYSTEM, {
    files: [document("empty.md", "\n\n")],
    languages: ["de"],
  });
  const strings = await instance.service.listStrings(SYSTEM, { language: "de" });
  assertEquals(strings.total, 0);
  const exported = await instance.service.exportFiles(SYSTEM, { languages: ["de"] });
  assertEquals(exported.files, [
    { path: "empty.md", language: "de", content: "", sha256: sha256Hex("") },
  ]);
});

test("export: an untranslated document is the English with a final newline, or no file with omit", async () => {
  using instance = await project();
  const files = (query: Parameters<typeof instance.service.exportFiles>[1]) =>
    instance.service
      .exportFiles(SYSTEM, query)
      .then((result) =>
        Object.fromEntries(result.files.map((file) => [`${file.language}/${file.path}`, file])),
      );
  const plain = await files({ languages: ["de"] });
  assertEquals(plain[`de/${PATH}`].content, `${ARTICLE}\n`);
  const omit = await files({ languages: ["de"], untranslated: "omit" });
  assertEquals(omit[`de/${PATH}`].content, "");
  assertEquals(omit[`de/${PATH}`].sha256, sha256Hex(""));
  assertEquals(omit["de/common.json"].content, "{}\n", "JSON files are never empty");
});

test("export: a translated document is its translation, normalized, byte-stable", async () => {
  using instance = await project();
  write(instance, PATH, "", "de", GERMAN.replaceAll("\n", "\r\n") + "\r\n");
  const first = await instance.service.exportFiles(SYSTEM, { languages: ["de"], files: [PATH] });
  assertEquals(first.files[0].content, `${GERMAN}\n`);
  assertEquals(first.files[0].sha256, sha256Hex(`${GERMAN}\n`));
  const second = await instance.service.exportFiles(SYSTEM, { languages: ["de"], files: [PATH] });
  assertEquals(second.files, first.files);
});

test("export: an outdated document is reported, and left out with outdated: omit", async () => {
  using instance = await project();
  write(instance, PATH, "", "de", GERMAN);
  await instance.service.upload(SYSTEM, {
    files: [document(PATH, `${ARTICLE}\n\nA new closing paragraph.\n`)],
    partial: true,
  });
  const written = await instance.service.exportFiles(SYSTEM, { languages: ["de"], files: [PATH] });
  assertEquals(written.files[0].content, `${GERMAN}\n`);
  assertEquals(
    written.files[0].outdated?.map((entry) => entry.key),
    [""],
  );
  const omitted = await instance.service.exportFiles(SYSTEM, {
    languages: ["de"],
    files: [PATH],
    outdated: "omit",
  });
  assertEquals(omitted.files[0].content, "");
  assertEquals(omitted.files[0].outdated, undefined);
});

test("writing a document stores it normalized, so a final newline is never a change", async () => {
  using instance = await project();
  assertEquals(write(instance, PATH, "", "de", `${GERMAN}\r\n`).status, "written");
  const strings = await instance.service.listStrings(SYSTEM, { language: "de", file: PATH });
  assertEquals(strings.strings[0].translation?.value, GERMAN);
  assertEquals(write(instance, PATH, "", "de", `${GERMAN}\n\n`).status, "unchanged");
});

test("a document translation with a merged paragraph is refused by the checks", async () => {
  using instance = await project();
  const merged = GERMAN.replace("\n\nManche", " Manche");
  const error = assertThrows(() => write(instance, PATH, "", "de", merged), ServiceError);
  assertEquals(error.code, "qa_failed");
  assertEquals(
    error.details?.map((detail) => [detail.check, detail.message]),
    [["paragraphs", "The English has 3 paragraphs; the translation has 2."]],
  );
});

test("import: Markdown translation files are imported whole, blank ones skipped, broken ones refused", async () => {
  using instance = await project();
  const result = await instance.service.importTranslations(SYSTEM, {
    language: "de",
    as: "blue",
    files: [
      { path: PATH, content: `${GERMAN.replaceAll("\n", "\r\n")}\r\n` },
      { path: "news/missing.md", content: "Nicht hochgeladen" },
    ],
  });
  assertEquals(
    { imported: result.imported, unknownFiles: result.unknownFiles, refused: result.refused },
    { imported: 1, unknownFiles: ["news/missing.md"], refused: [] },
  );
  const strings = await instance.service.listStrings(SYSTEM, { language: "de", file: PATH });
  assertEquals(strings.strings[0].translation?.value, GERMAN);
  assertEquals(strings.strings[0].translation?.colour, "blue");

  const blank = await instance.service.importTranslations(SYSTEM, {
    language: "pl",
    as: "green",
    files: [{ path: PATH, content: "\n" }],
  });
  assertEquals(
    { imported: blank.imported, skippedEmpty: blank.skippedEmpty },
    {
      imported: 0,
      skippedEmpty: 1,
    },
  );

  const broken = await instance.service.importTranslations(SYSTEM, {
    language: "pl",
    as: "green",
    files: [{ path: PATH, content: GERMAN.replace("\n\nManche", " Manche") }],
  });
  assertEquals(broken.imported, 0);
  assertEquals(
    broken.refused.map((refusal) => [refusal.key, refusal.checks.map((check) => check.check)]),
    [["", ["paragraphs"]]],
  );
});

test("a translation job translates a document as one text, marked as such in the prompt", async () => {
  const provider = scriptedProvider();
  using instance = await startTestService({ provider });
  const settings = loadSettings(instance.ctx);
  settings.llm.autoTranslate = false;
  saveSettings(instance.ctx, settings);
  await instance.service.upload(SYSTEM, {
    files: [document(PATH, `${ARTICLE}\n`)],
    languages: ["de"],
  });
  await uploadJson(instance.service, { "common.json": { title: "Wayfarer" } }, { partial: true });
  await instance.service.createJob(SYSTEM, { languages: ["de"] });
  await drain(instance);
  const documentRequests = provider.requests.filter((request) =>
    request.prompt.includes('"document":true'),
  );
  assertEquals(documentRequests.length, 1, "the document is a batch of its own");
  assertStringIncludes(documentRequests[0].system, "whole file");
  assertEquals(documentRequests[0].batch?.strings.length, 1);
  const strings = await instance.service.listStrings(SYSTEM, { language: "de", file: PATH });
  const translation = strings.strings[0].translation;
  assert(translation !== null, "the document was translated");
  assertEquals(translation.colour, "green");
  assertEquals(translation.qa, { errors: 0, warnings: 0 });
  const value = translation.value as string;
  assertEquals(value.split("\n\n").length, 3, "the paragraphs survive the fake translator");
  assertStringIncludes(value, "{{cityName}}");
});
