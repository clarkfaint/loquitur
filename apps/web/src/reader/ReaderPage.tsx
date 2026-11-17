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

import { type DocumentModel, type PdfAnchor, PdfAnchorSchema, type PlayerCommand } from "@lectern/core";
import { PlayerBar, ReaderView } from "@lectern/ui-web";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { SummaryDrawer } from "../ai/SummaryDrawer";
import { anchorsKey, originalKey } from "../import/import-service";
import { matchRoute, useHashRoute } from "../router";
import { getStorage } from "../services";
import { useSettingsStore } from "../settings/settings";
import { BookmarksPanel } from "./BookmarksPanel";
import { commandForKey } from "./keyboard";
import { PdfPageView } from "./PdfPageView";
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
  ".lectern-reader-page__views { border: 0; display: flex; gap: var(--lectern-space-2); margin: 0;",
  "  min-inline-size: 0; padding: 0; }",
  ".lectern-reader-page__view { background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-3); }",
  '.lectern-reader-page__view[aria-pressed="true"] { background: var(--lectern-accent-soft); }',
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
  ".lectern-reader-page__summarize { background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-3); }",
  '.lectern-reader-page__summarize[aria-expanded="true"] { background: var(--lectern-accent-soft); }',
  ".lectern-summary-drawer { background: var(--lectern-surface); border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-3); display: flex; flex-direction: column; gap: var(--lectern-space-3);",
  "  padding: var(--lectern-space-4); }",
  ".lectern-summary-drawer__close { align-self: end; background: transparent; border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-3); }",
  ".lectern-summary { display: flex; flex-direction: column; gap: var(--lectern-space-3); }",
  ".lectern-summary__head { align-items: center; display: flex; flex-wrap: wrap; gap: var(--lectern-space-3);",
  "  justify-content: space-between; }",
  ".lectern-summary__title { font-size: 1rem; margin: 0; }",
  ".lectern-summary__modes { border: 0; display: flex; gap: var(--lectern-space-2); margin: 0;",
  "  min-inline-size: 0; padding: 0; }",
  ".lectern-summary__mode, .lectern-summary__generate, .lectern-summary__listen { background: transparent;",
  "  border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-2); color: var(--lectern-ink);",
  "  cursor: pointer; font: inherit; padding: var(--lectern-space-2) var(--lectern-space-3); }",
  '.lectern-summary__mode[aria-pressed="true"] { background: var(--lectern-accent-soft); }',
  ".lectern-summary__generate { background: var(--lectern-accent); border-color: var(--lectern-accent);",
  "  color: var(--lectern-accent-ink); }",
  ".lectern-summary__generate:disabled, .lectern-summary__listen:disabled { cursor: not-allowed; opacity: 0.6; }",
  ".lectern-summary__empty, .lectern-summary__model, .lectern-summary__running { color: var(--lectern-ink-muted);",
  "  font-size: 0.875rem; margin: 0; }",
  ".lectern-summary__problem { color: var(--lectern-danger); margin: 0; }",
  ".lectern-summary__text { margin: 0; }",
  ".lectern-summary__takeaways { display: flex; flex-direction: column; gap: var(--lectern-space-2); margin: 0;",
  "  padding-left: var(--lectern-space-5); }",
  ".lectern-summary__actions { display: flex; flex-wrap: wrap; gap: var(--lectern-space-2); }",
].join("\n");

/** F§10.1's autoplay switch, as the query string spells it. */
const AUTOPLAY = "autoplay";

/**
 * The scale the page view lays its pages out at. F§10.1 gives the PDF page view no zoom control, so a
 * page is drawn at its own size; the view takes the scale as a prop, which is what a later control —
 * or an operator patch — would move.
 */
const PDF_SCALE = 1;

/** F§10.1's two ways of reading a document: the reflowed text, and the document's own pages. */
type ViewMode = "text" | "pages";

/** A PDF as the page view needs it: the bytes the hub read, and F§5.1's anchors written for them. */
interface PdfSource {
  bytes: Uint8Array;
  anchors: PdfAnchor[];
}

/**
 * The anchors a stored blob holds, validated one at a time with F§5.1's own schema (AGENTS.md §7: a
 * record from the library is external input). A blob that is not JSON, is not a list, or holds anything
 * that is not an anchor contributes the anchors it did prove and nothing else.
 */
function anchorsFrom(bytes: Uint8Array): PdfAnchor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const anchors: PdfAnchor[] = [];
  for (const entry of parsed) {
    const anchor = PdfAnchorSchema.safeParse(entry);
    if (anchor.success) anchors.push(anchor.data);
  }
  return anchors;
}

/**
 * `usePagesAvailable(docId, model)` — whether the library holds anchors for this document, which is
 * what makes a page view possible at all. The blob's *presence* is asked for and not its contents: the
 * bytes are read when the reader asks to see the pages, and not on every visit to the reader.
 */
function usePagesAvailable(docId: string, model: DocumentModel | null): boolean {
  const [available, setAvailable] = useState(false);
  const isPdf = model !== null && model.source.kind === "pdf";

  useEffect(() => {
    if (!isPdf) {
      setAvailable(false);
      return;
    }
    let live = true;
    void getStorage()
      .then(({ cache }) => cache.has(anchorsKey(docId)))
      .then(
        (held) => {
          if (live) setAvailable(held);
        },
        () => {
          if (live) setAvailable(false);
        },
      );
    return () => {
      live = false;
    };
  }, [docId, isPdf]);

  return available;
}

/**
 * `usePdfSource(docId, wanted)` — the document's original bytes and its anchors, read from the
 * library's blob cache (F§5.9) once the reader asks for the pages. Nothing is parsed here: the bytes
 * are the ones the hub read, and the anchors are F§5.1's.
 */
function usePdfSource(docId: string, wanted: boolean): PdfSource | null {
  const [source, setSource] = useState<PdfSource | null>(null);

  useEffect(() => {
    setSource(null);
    if (!wanted) return;
    let live = true;
    void (async () => {
      const { cache } = await getStorage();
      const [bytes, blob] = await Promise.all([cache.get(originalKey(docId)), cache.get(anchorsKey(docId))]);
      if (bytes === null || blob === null) return;
      const anchors = anchorsFrom(blob);
      if (anchors.length === 0) return;
      if (live) setSource({ bytes, anchors });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [docId, wanted]);

  return source;
}

export function ReaderPage(): ReactElement {
  const route = useHashRoute();
  const match = matchRoute("/read/:docId", route.hash);
  const docId = match?.params.docId ?? "";
  const player = usePlayer(docId);
  const preferences = useSettingsStore((state) => state.preferences);
  const update = useSettingsStore((state) => state.update);
  const [panelOpen, setPanelOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("text");
  const autoStarted = useRef(false);
  const { dispatch, snapshot } = player;
  const model = player.document;
  const pagesAvailable = usePagesAvailable(docId, model);
  const pdfSource = usePdfSource(docId, view === "pages");

  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = RULES;
    document.head.append(style);
  }, []);

  // A new document is read in the text view: the pages belong to the document that was asked for.
  const shownDocRef = useRef(docId);
  useEffect(() => {
    if (shownDocRef.current === docId) return;
    shownDocRef.current = docId;
    setView("text");
  }, [docId]);

  // `?autoplay=1` starts the reading once the document is loaded, and never a second time. The snapshot has to
  // be *this* document's: a reader who moves from one document to another with the switch in the address bar —
  // which is what F§9's "listen to the summary" does — would otherwise spend the one autoplay on the document
  // they are leaving, because the previous document's `ready` snapshot is still the one on screen while the new
  // player is being built.
  useEffect(() => {
    if (autoStarted.current) return;
    if (route.query.get(AUTOPLAY) !== "1") return;
    if (snapshot.docId !== docId || snapshot.state !== "ready") return;
    autoStarted.current = true;
    dispatch({ type: "play" });
  }, [dispatch, docId, route.query, snapshot.docId, snapshot.state]);

  // The keyboard belongs to the window: a reader pressing a key is not aiming at a control.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPanelOpen(false);
        setSummaryOpen(false);
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
          {pagesAvailable ? (
            <fieldset aria-label="View" className="lectern-reader-page__views">
              <button aria-pressed={view === "text"} className="lectern-reader-page__view" onClick={() => setView("text")} type="button">
                Text
              </button>
              <button aria-pressed={view === "pages"} className="lectern-reader-page__view" onClick={() => setView("pages")} type="button">
                Pages
              </button>
            </fieldset>
          ) : null}
          <button
            aria-expanded={panelOpen}
            className="lectern-reader-page__bookmarks"
            onClick={() => setPanelOpen((open) => !open)}
            type="button"
          >
            Bookmarks
          </button>
          <button
            aria-expanded={summaryOpen}
            className="lectern-reader-page__summarize"
            onClick={() => setSummaryOpen((open) => !open)}
            type="button"
          >
            Summarize
          </button>
        </div>
      </header>

      {player.problem === null ? null : (
        <p className="lectern-reader-page__problem" role="alert">
          {player.problem}
        </p>
      )}

      <div className={`lectern-reader-page__columns${panelOpen || summaryOpen ? "" : " lectern-reader-page__columns--solo"}`}>
        {model === null ? (
          <p className="lectern-reader-page__empty" role="status">
            Opening the document…
          </p>
        ) : view === "pages" && pdfSource !== null ? (
          <PdfPageView active={player.active} anchors={pdfSource.anchors} onSeek={seek} pdfBytes={pdfSource.bytes} scale={PDF_SCALE} />
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

        {summaryOpen && model !== null ? <SummaryDrawer docId={docId} onClose={() => setSummaryOpen(false)} /> : null}
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
