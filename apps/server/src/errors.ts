/**
 * The hub's errors (F§7.2): the one failure a route raises, the status each code answers with, and the Fastify
 * handlers that turn anything a route or the framework throws into F§7.2's envelope, `{ error: { code,
 * message } }`.
 *
 * Every body leaves through `ErrorBodySchema`, so what this hub answers is what a client's own copy of the
 * contract accepts. A failure the hub cannot classify answers `INTERNAL` with a message that says nothing
 * about the request: a stack trace or a caught value's text is not a client's business (F§11).
 */

import { ErrorBodySchema, type ErrorCode } from "@lectern/api-contract";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

/**
 * The status each code answers with (F§7.2): the code says what went wrong, the status says how a client
 * should read it. Engine failures are `502` because the hub is a proxy for the engine that failed.
 */
export const STATUS_FOR_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FORMAT: 415,
  INVALID_EPUB: 422,
  DRM_PROTECTED: 422,
  PARSE_FAILED: 500,
  EMPTY_DOCUMENT: 422,
  FETCH_REFUSED: 400,
  ENGINE_UNAVAILABLE: 502,
  UNKNOWN_VOICE: 404,
  INTERNAL: 500,
};

/** F§7.2's envelope, as the handler needs it: a code from the closed set, a message, and the status to send. */
export interface ClassifiedError {
  code: ErrorCode;
  message: string;
  status: number;
}

/**
 * A failure a route wants a client to see as it is written (F§7.2). The status defaults to the one its code
 * carries, and a route that needs another one — an unsatisfiable byte range, for example — passes it.
 */
export class HubError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number = STATUS_FOR_CODE[code]) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.status = status;
  }
}

/** A caught value's message, for a wrapper that has to name what failed. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A zod refusal as one line an operator can read: the failing path, then the rule it broke. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length === 0 ? "the value itself" : issue.path.join(".")}: ${issue.message}`).join("; ");
}

/**
 * The code, message and status a failure answers with. A `HubError` is taken as written; the framework's own
 * refusals keep their status and are read as the client's fault; everything else is `INTERNAL`, and only then
 * is the message replaced, so an unexpected failure never reaches a client in its own words.
 */
export function classifyError(error: FastifyError): ClassifiedError {
  if (error instanceof HubError) return { code: error.code, message: error.message, status: error.status };
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return { code: "PAYLOAD_TOO_LARGE", message: "the request body is larger than this hub accepts", status: 413 };
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return { code: "UNSUPPORTED_FORMAT", message: error.message, status: 415 };
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status >= 400 && status < 500) return { code: "BAD_REQUEST", message: error.message, status };
  return { code: "INTERNAL", message: "the hub could not complete this request", status: 500 };
}

/** F§7.2's error handler: every failure leaves as the envelope, with the status its code carries. */
export function hubErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  const classified = classifyError(error);
  reply.status(classified.status).send(ErrorBodySchema.parse({ error: { code: classified.code, message: classified.message } }));
}

/** The answer to a path no route matches (F§7.2): the same envelope, so a client never parses two shapes. */
export function hubNotFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  const message = `no route answers ${request.method} ${request.url}`;
  reply.status(404).send(ErrorBodySchema.parse({ error: { code: "NOT_FOUND", message } }));
}
