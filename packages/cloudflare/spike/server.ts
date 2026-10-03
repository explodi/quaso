// SPDX-License-Identifier: MIT
let busyUntil = 0;
let measureGrace = false;
const startedAt = Date.now();

async function batch(far: boolean, statements: { sql: string; params?: number[] }[]) {
  const start = performance.now();
  const response = await fetch("http://d1.quaso.internal/batch", {
    method: "POST",
    body: JSON.stringify({ far, statements }),
  });
  if (!response.ok) throw new Error(`D1: ${response.status} ${await response.text()}`);
  const results = await response.json();
  return { ms: performance.now() - start, results };
}

process.on("SIGTERM", () => {
  const receivedAt = Date.now();
  console.log(JSON.stringify({ signal: "SIGTERM", receivedAt }));
  void fetch("http://r2.quaso.internal/events/" + receivedAt + "-sigterm", {
    method: "PUT",
    body: JSON.stringify({ receivedAt }),
  });
  if (!measureGrace) {
    setTimeout(() => process.exit(0), 1000);
    return;
  }
  setInterval(() => {
    const elapsed = Date.now() - receivedAt;
    void fetch(`http://r2.quaso.internal/events/${Date.now()}-grace`, {
      method: "PUT",
      body: JSON.stringify({ elapsed }),
    });
  }, 5000);
  setTimeout(() => process.exit(0), 60_000);
});

Bun.serve({
  port: 8000,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/grace") {
      measureGrace = true;
      return new Response("ready");
    }
    if (url.pathname === "/healthz")
      return Response.json({ busy: Date.now() < busyUntil, startedAt });
    if (url.pathname === "/busy") {
      busyUntil = Date.now() + 70_000;
      return Response.json({ busyUntil, startedAt });
    }
    if (url.pathname === "/measure") {
      const far = url.searchParams.has("far");
      const reads: number[] = [];
      const commits: number[] = [];
      let metadata: unknown;
      for (let i = 0; i < 20; i++) {
        const read = await batch(far, [
          {
            sql: "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'revision'), 0) AS revision",
          },
        ]);
        const revision = read.results[0].results[0].revision;
        metadata = read.results[0].meta;
        const commit = await batch(far, [
          {
            sql: "UPDATE revision_guard SET expected_revision = ? WHERE id = 1",
            params: [revision],
          },
        ]);
        reads.push(read.ms);
        commits.push(commit.ms);
      }
      const put = await fetch("http://r2.quaso.internal/probe", {
        method: "PUT",
        body: "binding round trip",
      });
      const get = await fetch("http://r2.quaso.internal/probe");
      return Response.json({
        far,
        startedAt,
        reads,
        commits,
        metadata,
        r2: { put: put.status, text: await get.text() },
      });
    }
    return new Response(null, { status: 404 });
  },
});
