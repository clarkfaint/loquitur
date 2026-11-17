/**
 * The hub's server (F§7.2): Fastify, CORS, authentication, the two error handlers and the route registry.
 *
 * `buildApp` returns a ready instance and never listens — the entry point owns the socket, and a test injects
 * requests straight into the instance it built. Everything a route is given arrives as the context, so nothing
 * in this file needs to know what a route does.
 */

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createAuthHook } from "./auth";
import type { Config } from "./config";
import { createHubContext, type HubOverrides } from "./context";
import { hubErrorHandler, hubNotFoundHandler } from "./errors";
import { routes } from "./routes/index";
import { maxUploadBytes } from "./routes/parse";

/** The headers a browser client sends (F§7.2), and the response headers it has to be able to read. */
const ALLOWED_HEADERS = ["authorization", "content-type", "range", "x-lectern-filename"];
const EXPOSED_HEADERS = ["accept-ranges", "cache-control", "content-length", "content-range"];
const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "OPTIONS"];

/** What a caller may hand `buildApp` beside the configuration: F§7.1–F§7.3's pieces, and how to log. */
export interface BuildAppOptions extends HubOverrides {
  logger?: FastifyServerOptions["logger"];
}

/**
 * `buildApp(config, overrides)` — the hub, ready for requests.
 *
 * CORS answers any origin with the `Authorization` header and never allows credentials (F§7.2), because
 * authentication is header-based and cookie-free. The request hook runs before every route but the health
 * probe, and both handlers answer through F§7.2's envelope. The logger is off unless a caller asks for one,
 * so a hub built by a test is silent and the entry point decides what its log carries.
 */
export async function buildApp(config: Config, overrides: BuildAppOptions = {}): Promise<FastifyInstance> {
  const context = await createHubContext(config, overrides);
  const app = Fastify({ logger: overrides.logger ?? false });

  // F§7.2's raw-body form of `POST /v1/parse`: every content type but JSON arrives as the bytes the
  // client sent, and those bytes are the document. `application/json` keeps Fastify's own parser,
  // which is what tells the two forms of that route apart; `text/plain` is named beside the catch-all
  // because Fastify's plain-text parser would otherwise answer a text upload with a string rather
  // than its bytes. The limit is F§7.1's `LECTERN_MAX_UPLOAD_MB`, so an upload past it is refused
  // before a route sees it.
  app.addContentTypeParser(["text/plain", "*"], { parseAs: "buffer", bodyLimit: maxUploadBytes(config) }, (_request, body, done) => {
    done(null, body);
  });

  await app.register(cors, {
    origin: true,
    credentials: false,
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    methods: ALLOWED_METHODS,
  });
  app.addHook("onRequest", createAuthHook(config));
  app.setErrorHandler(hubErrorHandler);
  app.setNotFoundHandler(hubNotFoundHandler);
  // F§8.4's database lives as long as the app does: the close hook is where the connection is released, so
  // a test that closes the hub leaves no open SQLite handle behind and the entry point's shutdown is clean.
  app.addHook("onClose", () => {
    context.db.close();
  });
  for (const route of routes) route(app, context);
  return app;
}
