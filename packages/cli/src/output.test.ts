// SPDX-License-Identifier: MIT
import { assert, expect, test } from "vitest";
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
  expect(
    formatProblem({
      file: "src/locales/pl/common.json",
      key: "inventory.itemCount",
      language: "pl",
      message: "Placeholder {{total}} is missing.",
    }),
  ).toStrictEqual(
    "src/locales/pl/common.json › inventory.itemCount (pl): placeholder {{total}} is missing",
  );
  expect(
    formatProblem({ file: "src/en/a.json", line: 3, column: 19, message: "Trailing comma" }),
  ).toBe("src/en/a.json:3:19: trailing comma");
  expect(formatProblem({ key: "limits[0].file", message: "must end with .json" })).toStrictEqual(
    "limits[0].file: must end with .json",
  );
  expect(formatProblem({ message: "Something." })).toBe("something");
  expect(formatProblem({ language: "xx", message: "" })).toBe("(xx)");
});

test("sentenceFragment keeps acronyms and names", () => {
  expect(sentenceFragment("The few form is missing.")).toBe("the few form is missing");
  expect(sentenceFragment("QA failed.")).toBe("QA failed");
  expect(sentenceFragment("English is expected...")).toBe("English is expected...");
  expect(sentenceFragment("JSON syntax")).toBe("JSON syntax");
});

test("colours only on a terminal, never with NO_COLOR, TERM=dumb or --json", () => {
  const tty = { write() {}, isTTY: true };
  const pipe = { write() {}, isTTY: false };
  expect(useColour(tty, {}, false)).toBe(true);
  expect(useColour(pipe, {}, false)).toBe(false);
  expect(useColour(tty, { NO_COLOR: "1" }, false)).toBe(false);
  expect(useColour(tty, { NO_COLOR: "" }, false)).toBe(true);
  expect(useColour(tty, { TERM: "dumb" }, false)).toBe(false);
  expect(useColour(tty, {}, true)).toBe(false);
  const { output, text } = captured({ tty: true });
  output.print(output.out.red("red"));
  expect(text.stdout).toBe("\x1b[31mred\x1b[39m\n");
  const plain = captured({ tty: true, env: { NO_COLOR: "1" } });
  plain.output.print(plain.output.out.red("red"));
  expect(plain.text.stdout).toBe("red\n");
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
  expect(text.stdout).toBe("result\n");
  expect(text.stderr).toStrictEqual(
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
  expect(isClosedPipe(new Error("disk full"))).toBe(false);
  const broken = closed("Error", "EIO");
  const output = new Output({ stdout: broken, stderr: broken, env: {}, json: false });
  expect(() => output.print("result")).toThrow();
});

test("--json: one document with schemaVersion and command; print() is refused", () => {
  const { output, text } = captured({ json: true });
  output.document(resultDocument("status", 7, { languages: [] }));
  expect(JSON.parse(text.stdout)).toStrictEqual({
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
  expect(error).toStrictEqual({
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
  expect(
    table(
      [
        ["Language", "Green"],
        ["de", "\x1b[32m12\x1b[39m"],
        ["pt-BR", "3"],
      ],
      { right: [1] },
    ),
  ).toStrictEqual(["Language  Green", "de           \x1b[32m12\x1b[39m", "pt-BR         3"]);
});

test("shellQuote quotes only when needed", () => {
  expect(shellQuote("common.json:coins#plural=gold#plural")).toStrictEqual(
    "common.json:coins#plural=gold#plural",
  );
  expect(shellQuote('common.json:["a.b"]=c')).toStrictEqual(`'common.json:["a.b"]=c'`);
  expect(shellQuote("it's")).toStrictEqual(`'it'"'"'s'`);
  expect(shellQuote("")).toBe("''");
  expect(commandLine(["quaso", "upload", "--rename", "a b=c"])).toStrictEqual(
    "quaso upload --rename 'a b=c'",
  );
});
