/**
 * The floating widget (F§10.2): the reader's controls on a page the extension does not own.
 *
 * The widget is a *view*, in the same sense U-023's player bar is one: it renders the `PlayerSnapshot` it was
 * handed and answers a user action with a `PlayerCommand`, so no playback state lives here and nothing about
 * the page's reading is decided in this file. What it owns is only what a view owns — the pointer gesture in
 * progress — and even its own form is its host's: `expanded` is handed in, so the thing that measures the
 * widget is the thing that decides what it looks like.
 *
 * Two things about it are the contract's own rules rather than taste. It is *collapsed* into a pill by default
 * and expands into a bar, so the reader's page keeps its own space until the reader asks for controls; and it
 * is dragged by a real button — a `<button>` carrying the grip, not a bare element with a pointer handler — so
 * the same movement is available from the keyboard (arrow keys) as from a pointer. The arithmetic of that
 * movement is `./drag`'s, which is pure: this component reports a delta and never decides where the widget may
 * sit.
 *
 * Every shape here is drawn from basic geometry — a triangle, two bars, a chevron, six dots — inside the
 * player's own 24-unit box, so the widget ships no artwork and no reference-product asset.
 */

import type { PlayerCommand, PlayerSnapshot } from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import { CloseIcon, PauseIcon, PlayerBar, PlayIcon, SpeedControl } from "@lectern/ui-web";
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useRef } from "react";
import type { Point } from "./drag";

/** How far one arrow key moves the widget, in pixels. */
export const NUDGE_PX = 16;

/**
 * F§5.6(f)'s seed for the reader's own pace. The widget shows a pace but is not the view that measures it —
 * the running average belongs to the player — so it renders the same seed the web app starts from
 * (`apps/web/src/reader/use-player.ts`).
 */
export const BASE_WPM_SEED = 170;

/** The voices a compact bar is handed: the widget offers no voice picker, and F§10.1's compact variant has none. */
const NO_VOICES: Voice[] = [];

/** The player at rest, which is what the expanded bar draws before anything has been read (F§5.7's `idle`). */
export const IDLE_SNAPSHOT: PlayerSnapshot = {
  state: "idle",
  docId: null,
  sentenceIndex: 0,
  wordIndex: 0,
  rate: 1,
  voiceId: null,
  sleepRemainingMs: null,
  error: null,
};

/** Everything the widget is handed. Nothing here is state the widget keeps. */
export interface WidgetProps {
  /** The player's state as last published, or `null` while nothing has been read at all. */
  snapshot: PlayerSnapshot | null;
  /** Whether the bar is showing rather than the pill. */
  expanded: boolean;
  /** Show the bar, or go back to the pill. */
  onExpandChange: (expanded: boolean) => void;
  /** Start a reading of the page this widget is on. */
  onStart: () => void;
  /** Ask the player to do something (F§5.7). */
  onCommand: (command: PlayerCommand) => void;
  /** A drag began: the widget's position now is the gesture's origin. */
  onDragStart: () => void;
  /** The pointer has moved this far since the drag began. */
  onDrag: (delta: Point) => void;
  /** The drag ended: where the widget landed is worth remembering. */
  onDragEnd: () => void;
  /** One arrow-key nudge, relative to where the widget is now. */
  onNudge: (delta: Point) => void;
  /** Stop showing the player on this site, on this page and every later one. */
  onDisableSite: () => void;
}

/** The four arrow keys and the nudge each one asks for. */
function nudgeFor(key: string): Point | null {
  if (key === "ArrowLeft") return { x: -NUDGE_PX, y: 0 };
  if (key === "ArrowRight") return { x: NUDGE_PX, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -NUDGE_PX };
  if (key === "ArrowDown") return { x: 0, y: NUDGE_PX };
  return null;
}

/** Expand: a chevron pointing up, one stroked path inside the player's own box. */
function ExpandIcon() {
  return (
    <svg
      aria-hidden="true"
      className="lectern-icon"
      fill="none"
      focusable="false"
      height={20}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={20}
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

/** The grip: two columns of three dots, which is what a draggable thing looks like and nothing more. */
function GripIcon() {
  return (
    <svg aria-hidden="true" className="lectern-icon" focusable="false" height={20} viewBox="0 0 24 24" width={20}>
      {[7, 12, 17].map((y) => (
        <circle cx={10} cy={y} fill="currentColor" key={`left-${y}`} r={1.4} />
      ))}
      {[7, 12, 17].map((y) => (
        <circle cx={14} cy={y} fill="currentColor" key={`right-${y}`} r={1.4} />
      ))}
    </svg>
  );
}

/**
 * `Widget(props)` — the pill and the bar.
 *
 * The pill carries the two controls a reader needs while a page is being read (play or pause, and the way into
 * the rest) and the bar carries F§10.1's compact player bar, the speed control, the way out of the site and the
 * way back to the pill. Both carry the grip, because a reader who wants to move the widget should not have to
 * expand it first.
 */
export function Widget({
  snapshot,
  expanded,
  onExpandChange,
  onStart,
  onCommand,
  onDragStart,
  onDrag,
  onDragEnd,
  onNudge,
  onDisableSite,
}: WidgetProps) {
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const playing = snapshot?.state === "playing";
  const rate = snapshot?.rate ?? IDLE_SNAPSHOT.rate;

  function play(): void {
    // Nothing loaded, or a document already read to its end: what the reader wants is a reading, which is the
    // extension's own "read the page I am looking at" request rather than a command to a player with no document.
    if (snapshot === null || snapshot.state === "idle" || snapshot.state === "ended") {
      onStart();
      return;
    }
    onCommand({ type: "play" });
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragStart();
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const started = drag.current;
    if (started === null || started.pointerId !== event.pointerId) return;
    onDrag({ x: event.clientX - started.x, y: event.clientY - started.y });
  }

  function pointerUp(event: ReactPointerEvent<HTMLButtonElement>): void {
    const started = drag.current;
    if (started === null || started.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onDragEnd();
  }

  function gripKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const move = nudgeFor(event.key);
    if (move === null) return;
    event.preventDefault();
    onNudge(move);
  }

  const grip = (
    <button
      aria-label="Move the player"
      className="lectern-widget__grip"
      onKeyDown={gripKeyDown}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      title="Drag to move, or use the arrow keys"
      type="button"
    >
      <GripIcon />
    </button>
  );

  if (!expanded) {
    return (
      <div className="lectern-widget lectern-widget--pill">
        <button
          aria-label={playing ? "Pause" : "Play"}
          className="lectern-button lectern-widget__control lectern-widget__control--primary"
          onClick={playing ? () => onCommand({ type: "pause" }) : play}
          type="button"
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          aria-label="Expand the player"
          className="lectern-button lectern-widget__control"
          onClick={() => onExpandChange(true)}
          type="button"
        >
          <ExpandIcon />
        </button>
        {grip}
      </div>
    );
  }

  return (
    <div className="lectern-widget lectern-widget--bar">
      <PlayerBar
        baseWpm={BASE_WPM_SEED}
        onCommand={onCommand}
        progressFraction={0}
        remainingMs={0}
        snapshot={snapshot ?? IDLE_SNAPSHOT}
        variant="compact"
        voices={NO_VOICES}
      />
      <div className="lectern-widget__actions">
        <SpeedControl baseWpm={BASE_WPM_SEED} onCommand={onCommand} rate={rate} />
        {grip}
        <button
          aria-label="Disable the player on this site"
          className="lectern-button lectern-widget__action"
          onClick={onDisableSite}
          type="button"
        >
          Disable on this site
        </button>
        <button
          aria-label="Collapse the player"
          className="lectern-button lectern-widget__action lectern-widget__action--icon"
          onClick={() => onExpandChange(false)}
          type="button"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
