/**
 * `@lectern/ui-web` — the reader's web controls (F§10.1).
 *
 * The package is presentational by design: every component renders the `PlayerSnapshot` it is handed
 * and answers a user action with a `PlayerCommand`, so no playback state lives here and the same bar
 * serves the web app, the extension's side panel and the desktop window (F§5.7). The theme is a
 * stylesheet, exported as `@lectern/ui-web/styles.css`.
 */

export * from "./audio/html-audio-queue-sink";
export * from "./components/icons";
export * from "./components/PlayerBar";
export * from "./components/ReaderView";
export * from "./components/SleepTimerMenu";
export * from "./components/SpeedControl";
export * from "./components/VoicePicker";
export * from "./desktop-bridge";
export * from "./format";
export * from "./highlight/highlight-registry";
export * from "./highlight/locate";
export * from "./player/player-bus";
export * from "./scroll/auto-scroll";
export * from "./stores/device-id";
export * from "./stores/idb-blob-cache";
export * from "./stores/idb-library-store";
export * from "./stores/idb-schema";
