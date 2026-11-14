/**
 * The route registry (F§7.2): every route module the hub registers, in the order its table lists them.
 *
 * `app.ts` registers this list and nothing else, so a route is added by adding a module and one entry here,
 * and the file that builds the server never grows a route of its own.
 */

import type { FastifyInstance } from "fastify";
import type { HubContext } from "../context";
import { healthRoutes } from "./health";
import { parseRoutes } from "./parse";
import { ttsRoutes } from "./tts";
import { voicesRoutes } from "./voices";

/** One route module: it registers its own paths on the instance it is given. */
export type RouteRegistrar = (app: FastifyInstance, ctx: HubContext) => void;

export const routes: RouteRegistrar[] = [healthRoutes, voicesRoutes, ttsRoutes, parseRoutes];
