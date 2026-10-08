// SPDX-License-Identifier: MIT
/** `deno task cf:deploy` only deploys a named environment. */
import { describe, expect, it } from "vitest";
import { deployEnvironment, deployProblem } from "../scripts/deploy_args.ts";

describe("cf:deploy", () => {
  it("finds the environment", () => {
    expect(deployEnvironment(["--env", "staging"])).toBe("staging");
    expect(deployEnvironment(["--dry-run", "--env=production"])).toBe("production");
    expect(deployEnvironment(["-e", "production", "--minify"])).toBe("production");
    expect(deployEnvironment(["--dry-run"])).toBeNull();
    expect(deployEnvironment(["--env"])).toBeNull();
  });

  it("refuses the top level and unknown environments", () => {
    expect(deployProblem([])).toMatch(/Name the environment/);
    expect(deployProblem(["--env", "dev"])).toMatch(/Unknown environment "dev"/);
    expect(deployProblem(["--env", "staging"])).toBeNull();
    expect(deployProblem(["--env=production", "--dry-run"])).toBeNull();
  });
});
