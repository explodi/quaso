// SPDX-License-Identifier: MIT
import type { Session } from "../sessions.ts";
import type { Params } from "./router.ts";

/** What a route handler gets. Nothing about a request lives in module-level variables. */
export interface RequestContext {
  request: Request;
  url: URL;
  params: Params;
  requestId: string;
  /** The client's address (rate limits, logs). */
  ip?: string | null;
  /** The signed-in person's session, from the cookie (for `/api/` and `/auth/` paths). */
  session?: Session | null;
}

export type Handler = (context: RequestContext) => Promise<Response>;
