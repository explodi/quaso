// SPDX-License-Identifier: MIT
/**
 * Declaring a route of the API (`API_ROUTES`), with its handler typed by its schemas. Its
 * own module, so the route files (`api.ts` imports `accounts.ts`, `admin.ts` and `jobs.ts`)
 * share it without importing each other's values.
 */
import type { ObjectSchema, Schema } from "@quaso/core";
import type { ApiCall, ApiRoute } from "./api.ts";
type AnyObjectSchema = ObjectSchema<any>;

/** A route as declared: its handler's input is typed by its schemas. */
export type RouteDefinition<P, Q, B> = Omit<ApiRoute, "params" | "query" | "body" | "handle"> & {
  params?: AnyObjectSchema & Schema<P>;
  query?: AnyObjectSchema & Schema<Q>;
  body?: Schema<B>;
  handle(call: ApiCall<P, Q, B>): Promise<unknown>;
};

/** Declares a route, with its handler typed by its schemas. */
export function route<P = undefined, Q = undefined, B = undefined>(
  definition: RouteDefinition<P, Q, B>,
): ApiRoute {
  return definition as unknown as ApiRoute;
}
