// SPDX-License-Identifier: MIT
/** Isolated Gemini HTTP fixture for the production-image workflow; never deploy this service. */
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

let requests = 0;
let missingReferences = 0;
const tls = {
  key: readFileSync("/certs/key.pem", "utf8"),
  cert: readFileSync("/certs/cert.pem", "utf8"),
};

/** A fetch-style handler on `node:http`: this file runs alone in a container, without the server's `serve`. */
function bridge(handler: (request: Request) => Promise<Response>): http.RequestListener {
  return async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(new URL(incoming.url ?? "/", "https://stub"), {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      body: chunks.length > 0 ? Buffer.concat(chunks) : null,
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  };
}

const gemini = bridge(async (request) => {
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
  await new Promise((done) => setTimeout(done, 750));
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
});
https.createServer(tls, gemini).listen(443, "0.0.0.0");
const stats = bridge(async () => Response.json({ requests, missingReferences }));
http.createServer(stats).listen(8080, "0.0.0.0");
