import { z } from "zod";

/**
 * Every failure a route may report (F§7.2), as one closed set: the four request faults, the five a parser
 * answers with (F§5.4), the refusal a URL fetch can answer with, the two engine faults, and the catch-all.
 *
 * The list is closed on purpose — a client switches on it, and `ErrorCodeSchema` refuses anything beside it,
 * so a code a route invents fails its own response check instead of reaching a reader as an unexplained error.
 */
export const ErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_FORMAT",
  "INVALID_EPUB",
  "DRM_PROTECTED",
  "PARSE_FAILED",
  "EMPTY_DOCUMENT",
  "FETCH_REFUSED",
  "ENGINE_UNAVAILABLE",
  "UNKNOWN_VOICE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * F§7.2's error envelope, `{ error: { code, message } }`, and nothing beside it: the code is one of the set
 * above and the message is written for the operator reading a log or a toast. Strict at both levels, so a
 * route cannot leak a field the contract has no place for.
 */
export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
