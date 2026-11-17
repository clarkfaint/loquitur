/**
 * Phase 5's sync routes (F§7.2, F§8): pushing a device's pending ops, pulling the changes it has not seen
 * yet, and the two messages the change feed exchanges. Sync is record-level last-writer-wins (F§5.9): there
 * is no CRDT, no vector clock and no operational transform anywhere in these shapes, and an op travels
 * exactly as the outbox wrote it.
 *
 * Every record an op carries comes from `@lectern/core`'s own `OpSchema`, so an op a client receives is an
 * op its store can apply without a translation step.
 */

import { OpSchema } from "@lectern/core";
import { z } from "zod";
import { ErrorBodySchema } from "./common";

/** The most ops one push may carry (F§8.2: "the client sends up to 200 pending ops"). */
export const MAX_PUSH_OPS = 200;

/** The most changes one pull answers with (F§8.2: "limit 500"). */
export const MAX_PULL_LIMIT = 500;

/**
 * `POST /v1/sync/push` (F§7.2, F§8.2): one device's pending ops — at least one, at most 200. A request over
 * the limit is refused `TOO_MANY_OPS` rather than truncated, because a client whose ops were silently
 * dropped would believe they had synced.
 *
 * `deviceId` is an opaque, client-generated string (F§5.9): the hub stores it beside a record to break an
 * LWW tie and never treats it as an identity, so it carries no account, device-registration or permission.
 */
export const PushRequestSchema = z.strictObject({
  deviceId: z.string().min(1),
  ops: z.array(OpSchema).min(1).max(MAX_PUSH_OPS),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

/**
 * `POST /v1/sync/push` answer (F§7.2, F§8.2): every `opId` the hub accepted — which is every op in the
 * request, including the ones that lost the LWW rule — and the `rev` the batch left the change log at, which
 * a client stores as its cursor.
 */
export const PushResponseSchema = z.strictObject({
  accepted: z.array(z.string()),
  rev: z.int().nonnegative(),
});
export type PushResponse = z.infer<typeof PushResponseSchema>;

/**
 * `GET /v1/sync/pull`'s query (F§7.2, F§8.2): the last `rev` the client applied, and how many changes it
 * will take at most — 500 by default, the page size F§8.2's loop uses.
 */
export const PullQuerySchema = z.strictObject({
  since: z.int().nonnegative(),
  limit: z.int().min(1).max(MAX_PULL_LIMIT).default(MAX_PULL_LIMIT),
});
export type PullQuery = z.infer<typeof PullQuerySchema>;

/**
 * `GET /v1/sync/pull` answer (F§7.2, F§8.2): the changes after `since`, one op per changed entity, the
 * cursor to store, and whether another page is waiting — a client pulls again while `more` is true.
 */
export const PullResponseSchema = z.strictObject({
  changes: z.array(OpSchema),
  nextRev: z.int().nonnegative(),
  more: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponseSchema>;

/**
 * The messages a client sends on `GET /v1/sync/ws` (F§8.3): the first-message authentication and the answer
 * to the hub's `ping`. The feed is not a data channel — a `changed` message only tells a client to pull.
 *
 * The auth envelope is the one place a credential travels, because a socket has no header to carry one (the
 * bearer token is header-only everywhere else, F§11). That token is deliberately not a field of any schema
 * here: this unit's Forbidden Actions forbid modelling it and F§11 keeps it opaque, so the envelope is
 * validated loosely and a hub reads the credential beside the parsed message. `pong` carries nothing.
 */
export const WsClientMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("auth") }),
  z.strictObject({ type: z.literal("pong") }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

/**
 * The messages the hub sends on `GET /v1/sync/ws` (F§8.3): `ready` with the `rev` a socket starts from,
 * `changed` with the `rev` a commit moved the log to, and a periodic `ping` a client answers with `pong`.
 * None of them carries a record, a document or a token: F§8.3's feed carries no data.
 */
export const WsServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), rev: z.int().nonnegative() }),
  z.strictObject({ type: z.literal("changed"), rev: z.int().nonnegative() }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

/**
 * The two failures the sync routes name beyond F§7.2's shared set (F§8.2): a push carrying more ops than one
 * request may, and a document whose model the hub has never been sent. The list is closed, like every other
 * code set in this package, so a code a route invents fails its own response check.
 */
export const SyncErrorCodeSchema = z.enum(["MODEL_MISSING", "TOO_MANY_OPS"]);
export type SyncErrorCode = z.infer<typeof SyncErrorCodeSchema>;

/**
 * F§7.2's error object (`{ code, message }`, `./common`) carrying the sync code set above, so a sync route
 * can name a failure the shared envelope has no entry for and still answer a shape a client already parses.
 */
export const SyncErrorSchema = ErrorBodySchema.shape.error.extend({ code: SyncErrorCodeSchema });
export type SyncError = z.infer<typeof SyncErrorSchema>;
