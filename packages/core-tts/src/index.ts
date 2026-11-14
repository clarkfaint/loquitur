/**
 * `@lectern/core-tts` (F§6): the engine boundary, chunk identity, the two hand-written audio readers, the
 * mock engine, the synthesis path and the engine registry.
 *
 * Every module here is isomorphic — no Node built-in is imported anywhere outside the `__tests__`
 * directories — so the same package serves the hub, the browser, the extension and the desktop app. The
 * conformance suite lives at `@lectern/core-tts/testing`.
 */

export * from "./chunk-id";
export * from "./engine";
export * from "./kokoro-engine";
export * from "./mock-engine";
export * from "./mp3";
export * from "./piper-engine";
export * from "./registry";
export * from "./synthesize-chunk";
export * from "./wav";
