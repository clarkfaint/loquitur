/**
 * The widget's mount (F§10.2): one host element, one open shadow root, and the record of where the reader left
 * it.
 *
 * The host is a single element appended to `document.documentElement`, and everything the reader sees lives
 * inside its shadow root. That is what keeps the widget out of the page's way in both directions: the page's
 * styles cannot reach in (the shadow boundary, plus a root element that resets inheritance), and the widget's
 * styles cannot leak out, because they were never in the page's document to begin with. F§10.2 asks for an
 * *open* root, and it is open here for the reason the feature doc gives — an end-to-end case can drive the
 * widget the way a reader does.
 *
 * The two sheets come in as text (`?inline`), which is the only way a content script can put CSS inside a
 * shadow root: a `<link>` would be a network request to an extension URL, and a `<style>` element in the page
 * is a page element. `@lectern/ui-web/styles.css` is injected first so the shipped player bar and speed control
 * keep their own rules, and `widget.css` follows with the widget's layout and the `--lectern-*` token values
 * (a `:root` block matches nothing inside a shadow tree, so the widget declares them on its own host).
 *
 * This module owns the platform work — creating the host, measuring it, moving it, storing where it went — and
 * nothing else. The widget's own appearance and controls are `./Widget`'s.
 */

import type { PlayerCommand, PlayerSnapshot } from "@lectern/core";
import playerCss from "@lectern/ui-web/styles.css?inline";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ExtMessage, parseExtMessage } from "../../messages";
import { getSettings, setSettings } from "../../settings";
import { extractPageDocument } from "../page-document";
import type { ContentContext } from "../reading-session";
import { clampToViewport, nextPosition, type Point, type Size, type Viewport } from "./drag";
import { Widget } from "./Widget";
import widgetCss from "./widget.css?inline";

/** The host element's tag: a name of Lectern's own, so no page selector can mean it. */
export const WIDGET_HOST_TAG = "lectern-widget";

/** Where the widget keeps the position it was left at, one point per origin, in `chrome.storage.local`. */
export const WIDGET_POSITION_KEY = "lectern.extension.widget-position";

/** The default inset from the viewport's own edges, in pixels: the bottom-left corner (a `[DESIGN]` choice). */
const MARGIN_PX = 16;

/** The ids the two injected sheets carry, so a debugger can tell them apart inside the shadow root. */
const THEME_STYLE_ID = "lectern-widget-theme";
const WIDGET_STYLE_ID = "lectern-widget-styles";

/** The widget's assumed box before the browser has measured it, used only for the very first placement. */
const NOMINAL_SIZE: Size = { width: 96, height: 40 };

/** The page's own host name, which is what the settings record's `disabledSites` list holds. */
export function hostOf(doc: Document): string {
  return doc.location.hostname.toLowerCase();
}

/**
 * The positions a stored value means: one point per origin, each coordinate a number a style can carry. Every
 * field is validated here rather than trusted, because `chrome.storage` hands back whatever is in the profile.
 */
export function positionsFrom(value: unknown): Record<string, Point> {
  if (typeof value !== "object" || value === null) return {};
  const positions: Record<string, Point> = {};
  for (const [origin, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const point = entry as Record<string, unknown>;
    const { x, y } = point;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[origin] = { x, y };
  }
  return positions;
}

/**
 * Watch the player's state without ever answering it.
 *
 * This is the one listener a content-script feature cannot take from `ctx.listen`. That helper registers a
 * *responder* — one more `chrome.runtime.onMessage` listener that answers every message of the protocol — and a
 * tab's content script is reached with `chrome.tabs.sendMessage`, whose reply is a race between the listeners
 * that answer it. Measured in this unit's rehearsal: a responder here answered `ext/read-active-tab` with
 * `NO_HANDLER` before the reading session's own (asynchronous) reply was ready, and U-035's frozen case read
 * that refusal as a failure of the reading. A listener that returns nothing competes with nobody, so the
 * reading session stays the page's one responder and this one only watches.
 */
function watchSnapshots(handler: (snapshot: PlayerSnapshot) => void): void {
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = parseExtMessage(raw);
    if (message === null || message.type !== "ext/snapshot") return;
    handler(message.snapshot);
  });
}

/** What the rest of the content script can ask of the widget. */
export interface WidgetHandle {
  /** The host element, or `null` while the widget is not on the page. */
  readonly host: HTMLElement | null;
  /** Put the widget on the page, remembering where it was left. A no-op when it is already there. */
  mount(): Promise<void>;
  /** Take the widget off the page. */
  unmount(): void;
  /** Draw one player state. */
  apply(snapshot: PlayerSnapshot): void;
  /** The viewport changed: keep the widget inside it. */
  reflow(): void;
}

/**
 * `createWidget(ctx)` — the widget over one content-script context.
 *
 * Everything the widget needs from the page comes from `ctx`: the document it mounts into and the message
 * transport it commands the player through. Nothing is read from a global, so the same object serves a page and
 * a test document.
 */
export function createWidget(ctx: ContentContext): WidgetHandle {
  const doc = ctx.document;
  const origin = hostOf(doc);
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  let snapshot: PlayerSnapshot | null = null;
  let expanded = false;
  let position: Point = { x: MARGIN_PX, y: MARGIN_PX };
  let dragFrom: Point | null = null;
  let stored: Record<string, Point> = {};
  let restoring: Promise<void> | null = null;
  let placed = false;

  /** The viewport as the page's own window reports it. */
  function viewport(): Viewport {
    const view = doc.defaultView;
    return {
      width: view?.innerWidth ?? doc.documentElement.clientWidth,
      height: view?.innerHeight ?? doc.documentElement.clientHeight,
    };
  }

  /** The widget's own box, or the nominal one before the browser has laid it out. */
  function sizeOf(): Size {
    const box = host?.getBoundingClientRect();
    if (box === undefined || box.width === 0 || box.height === 0) return NOMINAL_SIZE;
    return { width: box.width, height: box.height };
  }

  /** The bottom-left corner, for an origin the reader has never moved the widget on. */
  function defaultPosition(size: Size): Point {
    const view = viewport();
    return clampToViewport({ x: MARGIN_PX, y: view.height - size.height - MARGIN_PX }, size, view);
  }

  /** Move the widget: the host's own style, and nothing else — the widget draws no position of its own. */
  function applyPosition(next: Point): void {
    position = next;
    if (host === null) return;
    host.style.left = `${next.x}px`;
    host.style.top = `${next.y}px`;
  }

  /**
   * Put the widget where it belongs, in the box the browser just gave it. The first placement is the reader's
   * own remembered position or the default corner, both of which need the widget's real height; every later one
   * is the same position pulled back inside a viewport or a box that changed under it — a resize, or the pill
   * growing into the bar.
   */
  function reflow(): void {
    if (host === null) return;
    const size = sizeOf();
    if (!placed) {
      placed = true;
      const remembered = stored[origin];
      applyPosition(remembered === undefined ? defaultPosition(size) : clampToViewport(remembered, size, viewport()));
      return;
    }
    applyPosition(clampToViewport(position, size, viewport()));
  }

  /**
   * Ask for a reflow once the browser has laid out whatever just changed. React commits on its own schedule, so
   * the widget cannot be measured in the same turn the render was asked for: a frame and a task are both
   * requested, and the reflow is idempotent, so whichever runs first is enough.
   */
  function scheduleReflow(): void {
    const view = doc.defaultView;
    view?.requestAnimationFrame(reflow);
    view?.setTimeout(reflow, 0);
  }

  /** Remember where the widget is, under this origin. */
  async function remember(): Promise<void> {
    stored = { ...stored, [origin]: position };
    await chrome.storage.local.set({ [WIDGET_POSITION_KEY]: stored }).catch(() => undefined);
  }

  /** Read the stored positions once, however many callers ask. */
  function restore(): Promise<void> {
    restoring ??= chrome.storage.local
      .get(WIDGET_POSITION_KEY)
      .then((read) => {
        stored = positionsFrom(read[WIDGET_POSITION_KEY]);
      })
      .catch(() => undefined);
    return restoring;
  }

  /** Send one message to the extension, ignoring a channel that is not there. */
  async function send(message: ExtMessage): Promise<void> {
    await ctx.send(message).catch(() => undefined);
  }

  /** Start reading this page: the extension's own request, the same one the popup's button makes. */
  async function startReading(): Promise<void> {
    // The contract's rule: the widget is always on the page from the moment a reading starts — and it is the
    // widget that starts this one, so it mounts before it asks.
    await mount();
    await send({ type: "ext/read-active-tab" });
  }

  /** Stop showing the player on this site: the settings record's own list, then off the page. */
  async function disableOnThisSite(): Promise<void> {
    const settings = await getSettings().catch(() => null);
    const disabled = settings === null ? [origin] : [...settings.disabledSites.filter((host) => host !== origin), origin];
    await setSettings({ disabledSites: disabled }).catch(() => undefined);
    unmount();
  }

  /** Show the pill, or the bar: the widget's own box changes with the form, so it is placed again after it. */
  function setExpanded(next: boolean): void {
    expanded = next;
    render();
    scheduleReflow();
  }

  /** The widget, as the element tree its props describe. */
  function element(): ReactElement {
    return createElement(Widget, {
      snapshot,
      expanded,
      onExpandChange: setExpanded,
      onStart: () => void startReading(),
      onCommand: (command: PlayerCommand) => void send({ type: "ext/command", command }),
      onDragStart: () => {
        dragFrom = position;
      },
      onDrag: (delta) => {
        if (dragFrom === null) return;
        applyPosition(clampToViewport(nextPosition(dragFrom, delta), sizeOf(), viewport()));
      },
      onDragEnd: () => {
        dragFrom = null;
        void remember();
      },
      onNudge: (delta) => {
        applyPosition(clampToViewport(nextPosition(position, delta), sizeOf(), viewport()));
        void remember();
      },
      onDisableSite: () => void disableOnThisSite(),
    });
  }

  function render(): void {
    root?.render(element());
  }

  /** One injected stylesheet, inside the shadow root the widget's styles must not escape. */
  function styleElement(id: string, css: string): HTMLStyleElement {
    const style = doc.createElement("style");
    style.id = id;
    style.textContent = css;
    return style;
  }

  async function mount(): Promise<void> {
    if (host !== null) return;
    await restore();
    if (host !== null) return;
    const container = doc.createElement("div");
    container.className = "lectern-widget-root";
    const hostElement = doc.createElement(WIDGET_HOST_TAG);
    // The host is positioned from here rather than from the shadow stylesheet, because a page's own rules for a
    // light-DOM element outrank the shadow tree's `:host` rules; an inline style outranks both.
    hostElement.style.display = "block";
    hostElement.style.position = "fixed";
    hostElement.style.zIndex = "2147483000";
    hostElement
      .attachShadow({ mode: "open" })
      .append(styleElement(THEME_STYLE_ID, playerCss), styleElement(WIDGET_STYLE_ID, widgetCss), container);
    doc.documentElement.append(hostElement);
    host = hostElement;
    root = createRoot(container);
    // A provisional corner, so the widget's first paint is near where it will stay rather than at the origin;
    // the measured placement follows the render.
    applyPosition(stored[origin] ?? defaultPosition(NOMINAL_SIZE));
    render();
    scheduleReflow();
  }

  /** Take the widget off the page: nothing of it is left in the document, and no state outlives the render. */
  function unmount(): void {
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
    dragFrom = null;
    placed = false;
  }

  return {
    get host() {
      return host;
    },

    mount,

    unmount,

    apply(next: PlayerSnapshot): void {
      snapshot = next;
      render();
    },

    reflow,
  };
}

/**
 * Whether the page holds text worth reading at all — the contract's "no readable text" rule. The page's own
 * extraction is what answers it (U-033's article root and block rules), and the extraction is then thrown
 * away: the text map a highlight is resolved through belongs to the reading session that reads the page, and a
 * widget that kept a second one would be keeping a second document.
 */
function hasReadableText(ctx: ContentContext): boolean {
  try {
    const extraction = extractPageDocument(ctx.document, ctx.env);
    return extraction.document.blocks.some((block) => block.sentences.some((sentence) => sentence.words.length > 0));
  } catch {
    return false;
  }
}

/**
 * Install the widget's feature on a content script (F§10.2).
 *
 * Two jobs, and neither of them is done on load: the widget is *offered* — mounted collapsed — only when the
 * reader's own settings ask for it, the site is not one they switched off, the page is the top frame, and the
 * page has text to read; and the player's state is drawn whenever a snapshot arrives, whether or not the widget
 * is on the page yet.
 */
export function installWidget(ctx: ContentContext): void {
  const widget = createWidget(ctx);

  watchSnapshots((snapshot) => widget.apply(snapshot));

  ctx.document.defaultView?.addEventListener("resize", () => widget.reflow());

  void offer(ctx, widget);
}

/** Mount the widget on a page the settings ask for it on, and leave every other page alone. */
async function offer(ctx: ContentContext, widget: WidgetHandle): Promise<void> {
  const view = ctx.document.defaultView;
  // A frame is not the page the reader is looking at, and a page with nothing to read has nothing to read aloud.
  if (view === null || view.top !== view.self) return;
  if (!hasReadableText(ctx)) return;
  const settings = await getSettings().catch(() => null);
  if (settings === null || !settings.autoShowWidget) return;
  if (settings.disabledSites.includes(hostOf(ctx.document))) return;
  await widget.mount();
}
