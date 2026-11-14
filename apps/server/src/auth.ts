/**
 * Authentication (F§7.2, F§11): one pre-shared bearer token, compared in constant time, on every route but the
 * health probe.
 *
 * The comparison is this module's own, over the UTF-16 code units of the two strings: it holds no
 * `node:crypto`, and so needs no Node ambient types, while still reading every character of the configured
 * token whatever the presented one looks like. The running difference folds in the length difference as well,
 * so a wrong-length token is not rejected before the comparison starts.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config";
import { HubError } from "./errors";

/** F§7.2's one exempt route: a probe that answered `401` could not tell an operator the hub is up. */
const EXEMPT_PATHS = new Set(["/healthz"]);

/** The one authorization form this hub accepts: the scheme, then the token. */
const BEARER = /^bearer[ \t]+(.+)$/i;

/** The path of a request URL, with its query string removed — the part an exemption is written against. */
export function pathOf(url: string): string {
  const [path] = url.split("?");
  return path ?? "/";
}

/**
 * `constantTimeEquals(left, right)` — do two strings hold the same characters?
 *
 * The answer takes the same number of steps for every pair of inputs: the loop runs to the longer string's
 * length, out-of-range positions read as zero, and the length difference is folded into the accumulator rather
 * than answered first. A caller therefore cannot learn a token's length, or how far a guess got, from timing.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const presented = index < left.length ? left.charCodeAt(index) : 0;
    const expected = index < right.length ? right.charCodeAt(index) : 0;
    difference |= presented ^ expected;
  }
  return difference === 0;
}

/**
 * `createAuthHook(config)` — the `onRequest` hook every route runs behind (F§7.2).
 *
 * A missing or malformed header, and a token that does not match, both answer `UNAUTHORIZED`; the message says
 * which of the two, and neither says anything about the configured token. `OPTIONS` is exempt because a
 * browser's preflight carries no `Authorization` header, and the health probe because it is the one route
 * meant to be reachable before a client has its token.
 */
export function createAuthHook(config: Config): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest): Promise<void> => {
    if (request.method === "OPTIONS") return;
    if (EXEMPT_PATHS.has(pathOf(request.url))) return;
    const header = request.headers.authorization;
    const match = header === undefined ? null : BEARER.exec(header.trim());
    if (match === null) throw new HubError("UNAUTHORIZED", "an `Authorization: Bearer <token>` header is required (F§7.2)");
    if (!constantTimeEquals(match[1] ?? "", config.token)) throw new HubError("UNAUTHORIZED", "the bearer token is not valid");
  };
}
