// SPDX-License-Identifier: MIT
/** Published downloads keep their content hash as an HTTP validator. */
import { FilePath, LanguageTag, s } from "@quaso/core";
import { ServiceError, type ServiceApi } from "@quaso/service";
import type { Authenticator } from "../auth.ts";
import type { Handler } from "../http/context.ts";
import { parseQuery } from "../http/request.ts";
import { conditionalResponse } from "../http/conditional.ts";

const FileParams = s.object({ language: LanguageTag, file: FilePath });
export function publishedFiles(
  service: Pick<ServiceApi, "getPublishedFile">,
  auth: Authenticator,
): Handler {
  return async ({ request, params, session }) => {
    const actor = await auth.actorFor(request, session);
    const input = parseQuery(FileParams, new URLSearchParams(params));
    const result = await service.getPublishedFile(actor, input).catch(async (error) => {
      if (actor.type === "token" && error instanceof ServiceError && error.code === "forbidden")
        await auth.recheck(request);
      throw error;
    });
    const etag = `"${result.version.sha256}"`;
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      ETag: etag,
      "Last-Modified": new Date(result.version.publishedAt).toUTCString(),
    });
    return conditionalResponse(request, new Response(result.content, { headers }));
  };
}
