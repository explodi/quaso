// SPDX-License-Identifier: MIT
/**
 * Errors the service reports to its callers. The server turns them into the API's error
 * shape (design §5.11), and the internal HTTP transport carries them across unchanged.
 */
import {
  type ApiErrorBody,
  ERROR_STATUS,
  type ErrorCode,
  type ErrorDetail,
  type TranslationInfo,
} from "@quaso/core";

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];
  /** For conflicts on a translation: the current translation. */
  readonly current?: TranslationInfo | null;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { details?: ErrorDetail[]; current?: TranslationInfo | null } = {},
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.details = extra.details;
    this.current = extra.current;
  }

  /** The HTTP status for this error. */
  get status(): number {
    return ERROR_STATUS[this.code];
  }

  /** The API's error body. */
  toBody(): ApiErrorBody {
    const error: ApiErrorBody["error"] = { code: this.code, message: this.message };
    if (this.details && this.details.length > 0) error.details = this.details;
    if (this.current !== undefined) error.current = this.current;
    return { error };
  }

  /** Rebuilds an error from an API error body, as the HTTP transport's client does. */
  static fromBody(body: ApiErrorBody): ServiceError {
    return new ServiceError(body.error.code, body.error.message, {
      details: body.error.details,
      current: body.error.current,
    });
  }
}

export const notFound = (what: string): ServiceError =>
  new ServiceError("not_found", `${what} was not found.`);

export const forbidden = (message = "You don't have permission to do that."): ServiceError =>
  new ServiceError("forbidden", message);

export const unauthorized = (message = "Sign in, or send an API key."): ServiceError =>
  new ServiceError("unauthorized", message);

export const badRequest = (message: string, details?: ErrorDetail[]): ServiceError =>
  new ServiceError("bad_request", message, { details });

export const conflict = (message: string, current?: TranslationInfo | null): ServiceError =>
  new ServiceError("conflict", message, { current });
