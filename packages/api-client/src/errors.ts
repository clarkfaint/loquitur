/**
 * The client's failure (F§7.2): one error type for every way a hub call can fail, carrying the code, the
 * status the hub answered with, and whether a hub was reached at all.
 *
 * A caller decides what to do from `code` — `UNAUTHORIZED` means the token, `UNKNOWN_VOICE` means the voice
 * picker — and never from the message, which is written for a person. `offline` is the one fact a code cannot
 * carry: F§7.2's set describes what a hub answered, and a request that never reached one answered nothing.
 */

import type { ErrorCode } from "@lectern/api-contract";

/** What a `HubClientError` is built from. `offline` is false for every answer a hub actually sent. */
export interface HubClientErrorInit {
  code: ErrorCode;
  /** The HTTP status, or `0` when no exchange happened. */
  status: number;
  message: string;
  offline?: boolean;
}

/**
 * One failed hub call (F§7.2).
 *
 * `code` is F§7.2's own closed set: the code the hub put in its envelope, or the code the client assigns when
 * the failure is its own — a transport that rejected the request, an answer that is not the shape the contract
 * defines. `status` is `0` when there is no HTTP answer to report. `offline` is true only for the transport
 * failure, which is the one a reader shows as "the hub is unreachable" rather than as a hub-side fault.
 */
export class HubClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly offline: boolean;

  constructor(init: HubClientErrorInit) {
    super(init.message);
    this.name = "HubClientError";
    this.code = init.code;
    this.status = init.status;
    this.offline = init.offline ?? false;
  }
}
