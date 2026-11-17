/**
 * `@lectern/api-client` (F§5.8, F§7.2): the typed client for the hub's phase-1 routes, and F§5.8's
 * `ChunkSource` built on it over F§5.9's `BlobCache`.
 *
 * The package is isomorphic. Every dependency — the transport, the cache, the token — arrives as an argument,
 * so the web app, the extension, the desktop app and the hub's own tests share one implementation. The adapter
 * that drives a hub without a socket lives at `@lectern/api-client/testing`.
 */

export * from "./ai-client";
export * from "./chunk-source";
export * from "./client";
export * from "./errors";
export * from "./sync-client";
export * from "./sync-engine";
