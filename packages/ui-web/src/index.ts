/**
 * `@lectern/ui-web` — the reader's web controls (F§10.1).
 *
 * The package is presentational by design: every component renders the `PlayerSnapshot` it is handed
 * and answers a user action with a `PlayerCommand`, so no playback state lives here and the same bar
 * serves the web app, the extension's side panel and the desktop window (F§5.7). The theme is a
 * stylesheet, exported as `@lectern/ui-web/styles.css`.
 */

export * from "./components/icons";
export * from "./components/PlayerBar";
export * from "./components/SleepTimerMenu";
export * from "./components/SpeedControl";
export * from "./components/VoicePicker";
export * from "./format";
