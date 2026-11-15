/**
 * The region overlay's own script (F§10.3): one drag, one rectangle, one `Esc`.
 *
 * The overlay window's whole purpose is to turn a drag into four numbers, and this is the drag. It is a plain
 * script in a plain page — no framework, no build step, nothing loaded from anywhere but this directory — and it
 * talks to the shell through exactly one thing: the bridge the overlay's preload exposes as
 * `window.lecternOverlay`, whose `submit(rect)` hands the rectangle over and whose `cancel()` gives up. The
 * channel names behind those two members belong to `src/preload/overlay.ts` and `../main/capture/overlay-window.ts`,
 * which are the two ends of them.
 *
 * Three decisions are the script's:
 *
 * - **The rectangle is drawn the way it is selected.** Every pointer move redraws it from the drag's origin to
 *   the pointer, so what the operator sees while dragging is exactly the region that will be read, including a
 *   drag that goes up and to the left.
 * - **A drag ends by being handed over, whatever its size.** Deciding what is big enough to read is the shell's
 *   (`isTooSmall`), which keeps one answer to "is this a region or a click" in the tested module rather than two
 *   answers in two processes.
 * - **`Esc` gives up.** The page owns the key because it is the surface the operator is looking at, and the
 *   shell is told through `cancel()` rather than by closing the window itself — a window that closed itself
 *   would leave the shell waiting for an answer that never came.
 */

/** The rectangle being drawn, in this page's own pixels: the same space the overlay window covers. */
const region = document.getElementById("region");

/** Where the current drag started, or `null` when no button is down. */
let origin = null;

/**
 * `draw(from, to)` — put the selection's rectangle where the two points describe it.
 *
 * The CSS box wants a top-left corner and a size, so the two dragged points are folded into both here. This is
 * presentation arithmetic and not a second answer to what a region is: the shell normalizes what it is handed
 * again (`normalizeRect`), which is where the answer that matters is given.
 */
function draw(from, to) {
  const left = Math.min(from.x, to.x);
  const top = Math.min(from.y, to.y);
  region.style.left = `${left}px`;
  region.style.top = `${top}px`;
  region.style.width = `${Math.abs(to.x - from.x)}px`;
  region.style.height = `${Math.abs(to.y - from.y)}px`;
}

/** Send the rectangle the drag describes to the shell, and stop drawing. */
function submit(from, to) {
  const rect = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
  window.lecternOverlay.submit(rect);
}

window.addEventListener("pointerdown", (event) => {
  // The left button only: a right click or a middle click is not a selection, and neither should start one.
  if (event.button !== 0) return;
  origin = { x: event.clientX, y: event.clientY };
  draw(origin, origin);
});

window.addEventListener("pointermove", (event) => {
  if (origin === null) return;
  draw(origin, { x: event.clientX, y: event.clientY });
});

window.addEventListener("pointerup", (event) => {
  if (origin === null) return;
  const from = origin;
  origin = null;
  submit(from, { x: event.clientX, y: event.clientY });
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  origin = null;
  window.lecternOverlay.cancel();
});
