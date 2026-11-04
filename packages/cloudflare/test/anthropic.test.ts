// SPDX-License-Identifier: MIT
import { createAnthropicProvider } from "@quaso/service";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_STUB_KEY, ANTHROPIC_STUB_URL } from "./anthropic_stub.ts";

function stubbedAnthropic(apiKey = ANTHROPIC_STUB_KEY) {
  return createAnthropicProvider({ apiKey, baseUrl: ANTHROPIC_STUB_URL, maxAttempts: 1 });
}

const REQUEST = {
  model: "claude-stub",
  system: "Translate game menus into German.",
  prompt: 'Translate:\n{"id":"s1","key":"play","english":"Play"}',
  responseSchema: { type: "object" },
  safety: "permissive" as const,
};

describe("the Anthropic provider in workerd", () => {
  it("uses native fetch to list models and translate with a closed JSON schema", async () => {
    const provider = stubbedAnthropic();
    expect(await provider.listModels()).toEqual(["claude-stub"]);
    const result = await provider.translate(REQUEST);
    expect(result.answer).toEqual({ translations: [{ id: "s1", text: "Spielen" }] });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, thinkingTokens: 0 });
  });

  it("generates file context as plain text", async () => {
    const result = await stubbedAnthropic().generateText(REQUEST);
    expect(result.text).toBe("The texts of a game's menus.");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, thinkingTokens: 0 });
  });

  it("refuses redirects instead of forwarding the API key", async () => {
    await expect(
      stubbedAnthropic().translate({ ...REQUEST, model: "claude-moved" }),
    ).rejects.toMatchObject({ kind: "invalid_request", status: 302 });
  });

  it("reports refused credentials as an auth error", async () => {
    await expect(stubbedAnthropic("sk-ant-wrong-key").translate(REQUEST)).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
  });
});
