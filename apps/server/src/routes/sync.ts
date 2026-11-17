/**
 * Phase 5's sync routes (F§7.2, F§8): a device pushes the ops its outbox holds and pulls the changes it has
 * not seen yet. Sync is record-level last-writer-wins (F§5.9) — no CRDT, no vector clock, no operational
 * transform — so both routes are thin: the push hands the batch to the repository, which applies the rule
 * and the op ledger, and the pull pages the change log it keeps.
 *
 * Three things this module owns rather than the repository:
 *
 * - **The push's refusals.** A body over F§7.2's 200-op cap is `TOO_MANY_OPS`, one of the two codes the sync
 *   envelope carries beyond the shared set, so it is answered here as `{ error: { code, message } }` rather
 *   than raised as a hub error the shared envelope would reject.
 * - **The document files a winning delete removes.** F§8.2's repository writes records; the bytes beside
 *   them are the document files' (U-055). The removal happens *after* the batch's transaction has committed,
 *   and only for a document whose delete won the LWW rule — a tombstone that lost leaves the bytes alone,
 *   and the bytes are never removed from inside the write.
 * - **The pull's query.** F§7.2's `?since=&limit=` arrives as strings; the contract's own schema reads whole
 *   numbers, so the two are read here and a value the schema cannot accept is `BAD_REQUEST`.
 *
 * A winning `document` put whose model the hub has never been sent is stored all the same: the record and
 * the bytes are separate (F§8.4), and a model may arrive later through the library routes. Nothing here
 * looks at the document files to decide whether a record may be written.
 */

import {
  MAX_PULL_LIMIT,
  MAX_PUSH_OPS,
  PullQuerySchema,
  PullResponseSchema,
  PushRequestSchema,
  PushResponseSchema,
  SyncErrorSchema,
} from "@lectern/api-contract";
import type { Op } from "@lectern/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { HubContext } from "../context";
import { describeIssues, HubError } from "../errors";

/** F§5.2's document id: the only shape that can name a document's directory, so the only shape worth removing. */
const DOCUMENT_ID = /^[0-9a-f]{32}$/;

/** Whether an op leaves a document tombstone, by its kind or by the record's own `deleted` flag. */
function isDocumentTombstone(op: Op): boolean {
  if (op.kind === "delete") return true;
  const record = op.record;
  return typeof record === "object" && record !== null && (record as { deleted?: unknown }).deleted === true;
}

/** A whole number in a query string, or `undefined` when the text is not one. */
function wholeNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * F§7.2's pull query as the contract's schema reads it. Fastify hands the query string's values as text, and
 * the schema's `since` and `limit` are integers, so the two keys it names are read as whole numbers; a key
 * the client sent but that is not one keeps the value it arrived with, so the refusal names the value rather
 * than reporting the field as missing.
 */
function pullQueryOf(query: unknown): unknown {
  const source = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  const candidate: Record<string, unknown> = {};
  for (const key of ["since", "limit"]) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    candidate[key] = wholeNumber(value) ?? value;
  }
  return candidate;
}

/**
 * F§7.2's `TOO_MANY_OPS`, answered in the sync envelope's own shape.
 *
 * The shared `ErrorBodySchema` is a closed set of thirteen codes and F§7.2's 200-op cap is not one of them,
 * so the sync envelope extends it with the two codes a sync route can name (`sync-api.ts`); this is the one
 * this module raises. The status is 400: the request is well-formed JSON the hub refuses on its size.
 */
function tooManyOps(reply: FastifyReply, count: number): void {
  const message = `a push carries at most ${MAX_PUSH_OPS} ops (F§7.2); this one carries ${count}`;
  reply.status(400).send({ error: SyncErrorSchema.parse({ code: "TOO_MANY_OPS", message }) });
}

/**
 * Remove the files of the documents whose delete won the batch's last-writer-wins rule.
 *
 * The repository's `changesSince` is the hub's own answer to "what did this batch change": reading the page
 * that starts at the revision the batch began at returns one entry per entity the batch wrote, carrying the
 * stamp of the write that won. A candidate op is therefore a document delete whose stamp is the stamp of the
 * current change — anything else lost, and its bytes stay. The removal runs after `applyOps` has committed,
 * so a request that is answered has already had its transaction settle, and a failure here cannot roll the
 * records back.
 */
async function removeWonDocumentFiles(ctx: HubContext, before: number, deviceId: string, ops: readonly Op[]): Promise<void> {
  const candidates = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.entity !== "document" || !DOCUMENT_ID.test(op.entityId) || !isDocumentTombstone(op)) continue;
    const writer = op.deviceId === "" ? deviceId : op.deviceId;
    const stamps = candidates.get(op.entityId) ?? new Set<string>();
    stamps.add(`${op.ts}|${writer}`);
    candidates.set(op.entityId, stamps);
  }
  if (candidates.size === 0) return;
  const page = ctx.records.changesSince(before, Math.max(1, ops.length));
  for (const change of page.changes) {
    if (change.entity !== "document" || change.kind !== "delete" || !DOCUMENT_ID.test(change.entityId)) continue;
    const stamps = candidates.get(change.entityId);
    if (stamps === undefined || !stamps.has(`${change.ts}|${change.deviceId}`)) continue;
    await ctx.files.removeDocument(change.entityId);
  }
}

export function syncRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.post("/v1/sync/push", async (request, reply): Promise<void> => {
    const body = request.body as { ops?: unknown } | null;
    if (body !== null && typeof body === "object" && Array.isArray(body.ops) && body.ops.length > MAX_PUSH_OPS) {
      tooManyOps(reply, body.ops.length);
      return;
    }
    const parsed = PushRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HubError("BAD_REQUEST", `the push body is not a sync push — ${describeIssues(parsed.error)}`);
    const before = ctx.records.currentRev();
    const result = ctx.records.applyOps(parsed.data.deviceId, parsed.data.ops);
    await removeWonDocumentFiles(ctx, before, parsed.data.deviceId, parsed.data.ops);
    reply.send(PushResponseSchema.parse({ accepted: result.accepted, rev: result.rev }));
  });

  app.get("/v1/sync/pull", async (request, reply): Promise<void> => {
    const parsed = PullQuerySchema.safeParse(pullQueryOf(request.query));
    if (!parsed.success) throw new HubError("BAD_REQUEST", `the pull query is not a sync pull — ${describeIssues(parsed.error)}`);
    reply.send(PullResponseSchema.parse(ctx.records.changesSince(parsed.data.since, parsed.data.limit)));
  });
}

/** F§7.2's pull page size, re-exported so a caller can size a query without importing the contract. */
export const DEFAULT_PULL_LIMIT = MAX_PULL_LIMIT;
