// SPDX-License-Identifier: MIT
import { validateStoreKey } from "../../service/src/store.ts";

/** Registered only on the container's private outbound hostname. */
export async function handleR2(request: Request, bucket: R2Bucket): Promise<Response> {
  const url = new URL(request.url);
  const objectRequest = url.pathname === "/object" && ["GET", "PUT"].includes(request.method);
  const collectionRequest =
    url.pathname === "/objects" && ["GET", "DELETE"].includes(request.method);
  if (!objectRequest && !collectionRequest) return new Response(null, { status: 404 });
  let key: string | undefined;
  let keys: string[] | undefined;
  try {
    if (objectRequest) {
      key = url.searchParams.get("key") ?? "";
      validateStoreKey(key);
    }
    if (request.method === "DELETE") {
      const input = (await request.json()) as { keys: string[] };
      if (!Array.isArray(input?.keys) || input.keys.length > 1000) throw new Error("Invalid keys");
      input.keys.forEach(validateStoreKey);
      keys = input.keys;
    }
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    if (request.method === "DELETE") {
      await bucket.delete(keys!);
      return new Response(null, { status: 204 });
    }
    if (collectionRequest) {
      const page = await bucket.list({
        prefix: url.searchParams.get("prefix") ?? "",
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return Response.json({
        items: page.objects.map((item) => ({ key: item.key, size: item.size, version: item.etag })),
        ...(page.truncated ? { cursor: page.cursor } : {}),
      });
    }
    if (request.method === "GET") {
      const object = await bucket.get(key!);
      return new Response(object?.body ?? null, { status: object === null ? 404 : 200 });
    }
    const match = url.searchParams.get("match");
    const onlyIf =
      match === null
        ? undefined
        : new Headers(
            match === "absent" ? { "If-None-Match": "*" } : { "If-Match": JSON.stringify(match) },
          );
    const stored = await bucket.put(key!, request.body, { onlyIf });
    if (stored === null) return Response.json({ error: "conflict" }, { status: 412 });
    return Response.json({ version: stored.etag });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
