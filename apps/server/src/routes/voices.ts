/**
 * `GET /v1/voices` (F§7.2): every voice of every enabled engine, as F§6's bare array.
 *
 * The list comes from the registry, which asks each engine and keeps the answers that arrived: an engine whose
 * service is down costs its own voices and nothing else, so one unreachable backend never empties the reader's
 * picker.
 */

import { type VoicesResponse, VoicesResponseSchema } from "@lectern/api-contract";
import type { FastifyInstance } from "fastify";
import type { HubContext } from "../context";

export function voicesRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get("/v1/voices", async (): Promise<VoicesResponse> => {
    return VoicesResponseSchema.parse(await ctx.engines.listVoices());
  });
}
