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

/**
 * F§8.3's plugin, reached through a `string`-typed specifier rather than a static import: its shipped
 * `types/index.d.ts` imports `ws`, whose declarations reach `@types/node`, and `Buffer` then becomes a real
 * type in this program — which re-breaks the two frozen `packages/core` parser lines U-023 and U-055 each
 * measured (`docx.ts:107` TS2740, `ocr-tesseract.ts:143` TS2345). Nothing this app may write can exclude the
 * declarations, so the module is imported the way U-046 and U-055 reached a native addon: through a string,
 * with the one member used declared here. It is the real plugin at runtime.
 */
const WS_PLUGIN_SPECIFIER = "@fastify/websocket" as string;

/** The one member of the plugin's default export this app registers: a Fastify plugin that owns upgrades. */
type WebSocketPlugin = (instance: FastifyInstance) => Promise<void>;

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
  // F§8.3's change feed is a socket, and the upgrade has to be dispatched through Fastify's own router for a
  // socket to run the hooks and reach the route it named — which is what this plugin does, in place of the
  // server's bare `upgrade` event. It is registered before the registry runs, because it reads the route
  // table as routes are added: a route declaring a `wsHandler` is a socket route, and every other request to
  // that path stays an ordinary HTTP request.
  const { default: websocket } = (await import(WS_PLUGIN_SPECIFIER)) as { default: WebSocketPlugin };
  await app.register(websocket);
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
