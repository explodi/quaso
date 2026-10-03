// SPDX-License-Identifier: MIT
/** Isolated Gemini HTTP fixture for the production-image workflow; never deploy this service. */
let requests = 0;
let missingReferences = 0;
const tls = { key: Bun.file("/certs/key.pem"), cert: Bun.file("/certs/cert.pem") };
Bun.serve({
  port: 443,
  hostname: "0.0.0.0",
  tls,
  async fetch(request) {
    if (request.headers.get("x-goog-api-key") !== "workflow-only-key")
      return new Response("Unexpected fixture key", { status: 403 });
    if (new URL(request.url).pathname === "/v1beta/models")
      return Response.json({
        models: [
          { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    if (!new URL(request.url).pathname.endsWith(":generateContent"))
      return new Response("Unknown fixture operation", { status: 404 });
    const body = (await request.json()) as { contents: { parts: { text: string }[] }[] };
    const prompt = body.contents.flatMap(({ parts }) => parts.map(({ text }) => text)).join("\n");
    requests++;
    const hasReferences =
      prompt.includes('"language":"es"') &&
      prompt.includes('"proofread":true') &&
      prompt.includes("[es]");
    if (!hasReferences) {
      missingReferences++;
      return new Response("The workflow prompt lacks proofread Spanish", { status: 400 });
    }
    const strings = prompt
      .split("\n")
      .filter((line) => line.startsWith('{"id":'))
      .map((line) => JSON.parse(line) as { id: string; english: string })
      .filter(({ english }) => typeof english === "string");
    if (strings.length === 0)
      return new Response("Unexpected workflow fixture strings", { status: 400 });
    await Bun.sleep(750);
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  translations: strings.map(({ id, english }) => ({
                    id,
                    text: `[translated] ${english}`,
                  })),
                }),
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    });
  },
});
Bun.serve({
  port: 8080,
  hostname: "0.0.0.0",
  fetch: () => Response.json({ requests, missingReferences }),
});
