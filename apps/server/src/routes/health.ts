/**
 * `GET /healthz` (F§7.2): the one route that answers without a token, so an operator — or a supervisor — can
 * ask whether the hub is up before it has a client's token.
 *
 * The answer names the engines the hub actually has, taken from the context rather than from the
 * configuration, so a hub whose engines were replaced answers with what it can really reach.
 */

import { type HealthResponse, HealthResponseSchema } from "@lectern/api-contract";
import type { FastifyInstance } from "fastify";
import { HUB_VERSION } from "../config";
import type { HubContext } from "../context";

export function healthRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get("/healthz", async (): Promise<HealthResponse> => {
    return HealthResponseSchema.parse({ ok: true, version: HUB_VERSION, engines: ctx.engines.ids() });
  });
}
