/**
 * `@lectern/api-contract` (F§7.2): the zod schemas for the hub's routes, so the hub that answers a request
 * and the client that makes it validate the same shape.
 *
 * The package is isomorphic — it holds no Node built-in, no server and no React — because the browser, the
 * extension, the desktop app and the hub all speak these routes. The error envelope every route shares lives
 * in `./common`; phase 1's engine routes live in `./engine-api`.
 */

export * from "./ai-api";
export * from "./common";
export * from "./engine-api";
export * from "./library-api";
export * from "./sync-api";
