/**
 * The reader screen (F§10.1): the document, the player bar, the bookmarks panel and the keyboard.
 *
 * The page owns no playback state — `usePlayer` does — so what is here is the wiring a reader sees: the
 * document title and the two reading toggles above it, the text itself with the word being read painted
 * through `ReaderView` (F§10.1's auto-scroll and click-to-seek come with that component), the bookmarks panel
 * beside it, and the player bar along the bottom.
 *
 * Two behaviours belong to the page rather than to the player. `?autoplay=1` starts playback once, and only
 * after the document has really loaded, so a deep link into a document begins reading itself without the
 * command racing the load. And the keyboard listener is here because it is the *window's*: F§10.1's
 * shortcuts are turned into commands by `commandForKey`, and `Esc` closes the panel, which is a view's
 * business and not a `PlayerCommand` (F§5.7 has no member for it).
 */

import type { PlayerCommand } from "@lectern/core";
import { PlayerBar, ReaderView } from "@lectern/ui-web";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { matchRoute, useHashRoute } from "../router";
import { useSettingsStore } from "../settings/settings";
import { BookmarksPanel } from "./BookmarksPanel";
import { commandForKey } from "./keyboard";
import { usePlayer } from "./use-player";

/** The id of the `<style>` element this screen's rules live in, as the library and settings screens do it. */
const STYLE_ID = "lectern-reader-page-styles";

/** How far furniture is dimmed when the reader asks to see it, in the stylesheet's own tokens. */
const RULES = [
  ".lectern-reader-page { display: flex; flex-direction: column; gap: var(--lectern-space-5); }",
  ".lectern-reader-page__head { align-items: end; display: flex; flex-wrap: wrap; gap: var(--lectern-space-4);",
  "  justify-content: space-between; }",
  ".lectern-reader-page__title { font-size: 1.25rem; margin: 0; }",
  ".lectern-reader-page__tools { align-items: center; display: flex; flex-wrap: wrap; gap: var(--lectern-space-4); }",
  ".lectern-reader-page__toggle { align-items: center; color: var(--lectern-ink-muted); display: flex;",
  "  font-size: 0.875rem; gap: var(--lectern-space-2); }",
  ".lectern-reader-page__bookmarks { background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-3); }",
  '.lectern-reader-page__bookmarks[aria-expanded="true"] { background: var(--lectern-accent-soft); }',
  ".lectern-reader-page__columns { align-items: start; display: grid; gap: var(--lectern-space-5);",
  "  grid-template-columns: minmax(0, 3fr) minmax(16rem, 1fr); }",
  ".lectern-reader-page__columns--solo { grid-template-columns: minmax(0, 1fr); }",
  ".lectern-reader-page__problem { color: var(--lectern-danger); }",
  ".lectern-reader-page__empty { color: var(--lectern-ink-muted); }",
  ".lectern-bookmarks { background: var(--lectern-surface); border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-3); display: flex; flex-direction: column; gap: var(--lectern-space-3);",
  "  padding: var(--lectern-space-4); }",
  ".lectern-bookmarks__head { align-items: center; display: flex; justify-content: space-between; }",
  ".lectern-bookmarks__head h2 { font-size: 1rem; margin: 0; }",
  ".lectern-bookmarks__form { display: flex; flex-direction: column; gap: var(--lectern-space-1); }",
  ".lectern-bookmarks__form label { color: var(--lectern-ink-muted); font-size: 0.875rem; }",
  ".lectern-bookmarks__form input { background: var(--lectern-paper); border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-ink); font: inherit; padding: var(--lectern-space-2); }",
  ".lectern-bookmarks__form button, .lectern-bookmarks__actions button, .lectern-bookmarks__close {",
  "  background: transparent; border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-2);",
  "  color: var(--lectern-ink); cursor: pointer; font: inherit; padding: var(--lectern-space-2) var(--lectern-space-3); }",
  ".lectern-bookmarks__form button { background: var(--lectern-accent); border-color: var(--lectern-accent);",
  "  color: var(--lectern-accent-ink); }",
  ".lectern-bookmarks__hint, .lectern-bookmarks__empty, .lectern-bookmarks__where, .lectern-bookmarks__note {",
  "  color: var(--lectern-ink-muted); font-size: 0.875rem; margin: 0; }",
  ".lectern-bookmarks__problem { color: var(--lectern-danger); margin: 0; }",
  ".lectern-bookmarks__list { display: flex; flex-direction: column; gap: var(--lectern-space-3);",
  "  list-style: none; margin: 0; padding: 0; }",
  ".lectern-bookmarks__item { border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-2);",
  "  display: flex; flex-direction: column; gap: var(--lectern-space-1); padding: var(--lectern-space-3); }",
  ".lectern-bookmarks__actions { display: flex; flex-wrap: wrap; gap: var(--lectern-space-2); }",
  ".lectern-mini { display: flex; flex-direction: column; gap: var(--lectern-space-3); }",
  ".lectern-mini__title { font-size: 1rem; margin: 0; }",
  ".lectern-mini__empty { color: var(--lectern-ink-muted); }",
].join("\n");

/** F§10.1's autoplay switch, as the query string spells it. */
const AUTOPLAY = "autoplay";

export function ReaderPage(): ReactElement {
  const route = useHashRoute();
  const match = matchRoute("/read/:docId", route.hash);
  const docId = match?.params.docId ?? "";
  const player = usePlayer(docId);
  const preferences = useSettingsStore((state) => state.preferences);
  const update = useSettingsStore((state) => state.update);
  const [panelOpen, setPanelOpen] = useState(false);
  const autoStarted = useRef(false);
  const { dispatch, snapshot } = player;
  const model = player.document;

  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = RULES;
    document.head.append(style);
  }, []);

  // `?autoplay=1` starts the reading once the document is loaded, and never a second time.
  useEffect(() => {
    if (autoStarted.current) return;
    if (route.query.get(AUTOPLAY) !== "1") return;
    if (snapshot.state !== "ready") return;
    autoStarted.current = true;
    dispatch({ type: "play" });
  }, [dispatch, route.query, snapshot.state]);

  // The keyboard belongs to the window: a reader pressing a key is not aiming at a control.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPanelOpen(false);
        return;
      }
      const command = commandForKey(event, snapshot);
      if (command === null) return;
      event.preventDefault();
      dispatch(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, snapshot]);

  const seek = (position: { sentenceIndex: number; wordIndex: number }): void => {
    dispatch({ type: "seek", sentenceIndex: position.sentenceIndex, wordIndex: position.wordIndex } satisfies PlayerCommand);
  };

  if (player.notFound) {
    return (
      <main className="lectern-reader-page">
        <h1>Not in this library</h1>
        <p className="lectern-reader-page__empty" role="status">
          No document is held under that address. <a href="#/library">Back to the library</a>.
        </p>
      </main>
    );
  }

  return (
    <main className="lectern-reader-page">
      <header className="lectern-reader-page__head">
        <h1 className="lectern-reader-page__title">{model === null ? "" : model.title}</h1>
        <div className="lectern-reader-page__tools">
          <label className="lectern-reader-page__toggle">
            <input
              checked={preferences.skipFurniture}
              onChange={(event) => void update({ preferences: { skipFurniture: event.target.checked } })}
              type="checkbox"
            />
            Skip headers, footers and footnotes
          </label>
          <label className="lectern-reader-page__toggle">
            <input
              checked={preferences.skipCitations}
              onChange={(event) => void update({ preferences: { skipCitations: event.target.checked } })}
              type="checkbox"
            />
            Skip citation markers
          </label>
          <button
            aria-expanded={panelOpen}
            className="lectern-reader-page__bookmarks"
            onClick={() => setPanelOpen((open) => !open)}
            type="button"
          >
            Bookmarks
          </button>
        </div>
      </header>

      {player.problem === null ? null : (
        <p className="lectern-reader-page__problem" role="alert">
          {player.problem}
        </p>
      )}

      <div className={`lectern-reader-page__columns${panelOpen ? "" : " lectern-reader-page__columns--solo"}`}>
        {model === null ? (
          <p className="lectern-reader-page__empty" role="status">
            Opening the document…
          </p>
        ) : (
          <ReaderView active={player.active} document={model} onSeek={seek} showSkipped={!preferences.skipFurniture} />
        )}

        {panelOpen && model !== null ? (
          <BookmarksPanel
            docId={docId}
            onClose={() => setPanelOpen(false)}
            onJump={seek}
            position={player.active ?? { sentenceIndex: snapshot.sentenceIndex, wordIndex: snapshot.wordIndex }}
          />
        ) : null}
      </div>

      {model === null ? null : (
        <PlayerBar
          baseWpm={player.baseWpm}
          onCommand={dispatch}
          progressFraction={player.progressFraction}
          remainingMs={player.remainingMs}
          snapshot={snapshot}
          variant="full"
          voices={player.voices}
        />
      )}
    </main>
  );
}
