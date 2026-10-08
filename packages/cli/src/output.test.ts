// SPDX-License-Identifier: MIT
import { test } from "node:test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { SCHEMA_VERSION } from "@quaso/core";
import { CliError } from "./errors.ts";
import {
  commandLine,
  errorDocument,
  formatProblem,
  isClosedPipe,
  Output,
  resultDocument,
  sentenceFragment,
  shellQuote,
  table,
  useColour,
} from "./output.ts";
import { captured } from "./test_helpers.ts";

test("formatProblem uses the design's format, with local paths", () => {
  assertEquals(
    formatProblem({
      file: "src/locales/pl/common.json",
      key: "inventory.itemCount",
      language: "pl",
      message: "Placeholder {{total}} is missing.",
    }),
    "src/locales/pl/common.json › inventory.itemCount (pl): placeholder {{total}} is missing",
  );
  assertEquals(
    formatProblem({ file: "src/en/a.json", line: 3, column: 19, message: "Trailing comma" }),
    "src/en/a.json:3:19: trailing comma",
  );
  assertEquals(
    formatProblem({ key: "limits[0].file", message: "must end with .json" }),
    "limits[0].file: must end with .json",
  );
  assertEquals(formatProblem({ message: "Something." }), "something");
  assertEquals(formatProblem({ language: "xx", message: "" }), "(xx)");
});

test("sentenceFragment keeps acronyms and names", () => {
  assertEquals(sentenceFragment("The few form is missing."), "the few form is missing");
  assertEquals(sentenceFragment("QA failed."), "QA failed");
  assertEquals(sentenceFragment("English is expected..."), "English is expected...");
  assertEquals(sentenceFragment("JSON syntax"), "JSON syntax");
});

test("colours only on a terminal, never with NO_COLOR, TERM=dumb or --json", () => {
  const tty = { write() {}, isTTY: true };
  const pipe = { write() {}, isTTY: false };
  assertEquals(useColour(tty, {}, false), true);
  assertEquals(useColour(pipe, {}, false), false);
  assertEquals(useColour(tty, { NO_COLOR: "1" }, false), false);
  assertEquals(useColour(tty, { NO_COLOR: "" }, false), true);
  assertEquals(useColour(tty, { TERM: "dumb" }, false), false);
  assertEquals(useColour(tty, {}, true), false);
  const { output, text } = captured({ tty: true });
  output.print(output.out.red("red"));
  assertEquals(text.stdout, "\x1b[31mred\x1b[39m\n");
  const plain = captured({ tty: true, env: { NO_COLOR: "1" } });
  plain.output.print(plain.output.out.red("red"));
  assertEquals(plain.text.stdout, "red\n");
});

test("results go to stdout, logs and errors to stderr", () => {
  const { output, text } = captured();
  output.print("result");
  output.info("progress");
  output.warn("careful");
  output.error(
    new CliError(5, "1 source file can't be read.", {
      details: [{ file: "src/en/a.json", line: 1, column: 2, message: "Unexpected end of file" }],
      hint: "Fix it.",
    }),
  );
  assertEquals(text.stdout, "result\n");
  assertEquals(
    text.stderr,
    "progress\nwarning: careful\nerror: 1 source file can't be read.\n" +
      "  src/en/a.json:1:2: unexpected end of file\nFix it.\n",
  );
});

// Regression: a closed stderr (`quaso upload 2>&1 | head -1`) crashed with exit code 1.
test("a closed pipe is ignored on both streams", () => {
  const closed = (name: string, code?: string) => ({
    write() {
      throw Object.assign(new Error("closed"), { name, code });
    },
  });
  for (const stream of [closed("Error", "EPIPE"), closed("BrokenPipe")]) {
    const output = new Output({ stdout: stream, stderr: stream, env: {}, json: false });
    output.print("result");
    output.info("progress");
    output.warn("careful");
    output.error(new CliError(3, "No key."));
    output.raw("stack");
  }
  assert(isClosedPipe({ code: "ERR_STREAM_DESTROYED" }));
  assertEquals(isClosedPipe(new Error("disk full")), false);
  const broken = closed("Error", "EIO");
  const output = new Output({ stdout: broken, stderr: broken, env: {}, json: false });
  assertThrows(() => output.print("result"));
});

test("--json: one document with schemaVersion and command; print() is refused", () => {
  const { output, text } = captured({ json: true });
  output.document(resultDocument("status", 7, { languages: [] }));
  assertEquals(JSON.parse(text.stdout), {
    schemaVersion: SCHEMA_VERSION,
    command: "status",
    ok: false,
    exitCode: 7,
    result: { languages: [] },
  });
  let refused = false;
  try {
    output.print("text");
  } catch {
    refused = true;
  }
  assert(refused);
  const error = errorDocument(
    "upload",
    new CliError(3, "QUASO_API_KEY isn't set.", { code: "missing_key", hint: "Set it." }),
  );
  assertEquals(error, {
    schemaVersion: SCHEMA_VERSION,
    command: "upload",
    ok: false,
    exitCode: 3,
    error: {
      code: "missing_key",
      message: "QUASO_API_KEY isn't set.",
      details: [],
      hint: "Set it.",
    },
  });
});

test("error details are capped in text mode", () => {
  const { output, text } = captured();
  const details = Array.from({ length: 60 }, (_, index) => ({
    file: `f${index}.json`,
    message: "bad",
  }));
  output.error(new CliError(5, "Bad files.", { details }));
  assert(text.stderr.includes("f49.json: bad"));
  assert(!text.stderr.includes("f50.json"));
  assert(text.stderr.includes("… and 10 more (--json lists them all)"));
});

test("table pads columns, aligns numbers right, and ignores colour codes", () => {
  assertEquals(
    table(
      [
        ["Language", "Green"],
        ["de", "\x1b[32m12\x1b[39m"],
        ["pt-BR", "3"],
      ],
      { right: [1] },
    ),
    ["Language  Green", "de           \x1b[32m12\x1b[39m", "pt-BR         3"],
  );
});

test("shellQuote quotes only when needed", () => {
  assertEquals(
    shellQuote("common.json:coins#plural=gold#plural"),
    "common.json:coins#plural=gold#plural",
  );
  assertEquals(shellQuote('common.json:["a.b"]=c'), `'common.json:["a.b"]=c'`);
  assertEquals(shellQuote("it's"), `'it'"'"'s'`);
  assertEquals(shellQuote(""), "''");
  assertEquals(
    commandLine(["quaso", "upload", "--rename", "a b=c"]),
    "quaso upload --rename 'a b=c'",
  );
});
