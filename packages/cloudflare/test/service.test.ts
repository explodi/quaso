// SPDX-License-Identifier: MIT
/** The deployed D1 service reproduces the local SQLite scenario and file bytes. */
import { beforeEach, describe, expect, it } from "vitest";
import { resetUploadSql } from "../../service/src/testing/upload_cases.ts";
import { sql } from "./env.ts";
import fixture from "./fixtures/demo.json";
import { runScenario, type ScenarioInput } from "./scenario.ts";
import { ANONYMOUS, createAsyncService, SYSTEM } from "@quaso/service";

describe("the demo scenario on D1", () => {
  beforeEach(() => resetUploadSql(sql, { empty: true }));
  it("gives exactly the local SQLite reads, exports, backup and table rows", async () => {
    const output = await runScenario(sql, fixture.input as unknown as ScenarioInput);
    expect(output.export).toEqual(fixture.output.export);
    expect(output).toEqual(fixture.output);
  });
  it("searches with 200 CJK characters and treats SQL wildcard characters literally", async () => {
    const service = createAsyncService({
      sql,
      scheduler: { schedule() {}, cancel() {} },
      secretKey: "search-test",
    });
    await service.start();
    const story = "你好，旅行者。".repeat(40);
    await service.upload(SYSTEM, {
      files: [
        {
          path: "story.json",
          repoPath: "story.json",
          content: JSON.stringify({ intro: story, save: "C:\\Games\\save_1" }),
        },
      ],
      languages: ["pl"],
    });
    expect(
      (
        await service.listStrings(ANONYMOUS, { language: "pl", q: story.slice(3, 203) })
      ).strings.map((row) => row.key),
    ).toEqual(["intro"]);
    expect(
      (
        await service.listStrings(ANONYMOUS, { language: "pl", q: "c:\\games\\save_1" })
      ).strings.map((row) => row.key),
    ).toEqual(["save"]);
    expect((await service.listStrings(ANONYMOUS, { language: "pl", q: "%" })).strings).toEqual([]);
  });
});
