// SPDX-License-Identifier: MIT
/** GET validators and HEAD apply equally to origin responses and cached copies. */
export function conditionalResponse(request: Request, response: Response): Response {
  const read = request.method === "GET" || request.method === "HEAD";
  if (!read) return response;
  const etag = response.headers.get("ETag");
  const validators =
    request.headers
      .get("If-None-Match")
      ?.split(",")
      .map((value) => value.trim().replace(/^W\//, "")) ?? [];
  const unchanged =
    response.status === 200 &&
    (validators.includes("*") || (etag !== null && validators.includes(etag)));
  if (!unchanged && request.method !== "HEAD") return response;
  void response.body?.cancel();
  const headers = new Headers(response.headers);
  if (unchanged) headers.delete("Content-Length");
  return new Response(null, { status: unchanged ? 304 : response.status, headers });
}
