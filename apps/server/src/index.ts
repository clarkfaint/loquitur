/**
 * `@lectern/server` (F§7.1–F§7.3): the hub's server skeleton, its configuration, its authentication and the
 * phase-1 routes.
 *
 * The package is Node-only — it is the one piece of Lectern that listens on a socket — and every module below
 * `src` except the entry point is handed what it needs, so the hub can be built and driven without a process
 * of its own.
 */

export { type BuildAppOptions, buildApp } from "./app";
export { type Config, HUB_VERSION, type HubEnv, loadConfig } from "./config";
