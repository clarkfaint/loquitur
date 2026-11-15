/**
 * The region overlay's bridge (F§10.3): `submit(rect)` and `cancel()`, and nothing else.
 *
 * The overlay window is the one window of the shell that is not the app: it is a page whose whole job is to turn
 * one drag into four numbers, and F§11's rule — the page gets the members it needs and no more — is why it is
 * handed this object rather than the app's own bridge. `submit(rect)` hands a rectangle to the main process and
 * `cancel()` says the operator gave up; both are one-way messages, because neither of them has an answer the
 * page could use, and the page closes either way.
 *
 * **This file is shipped as written, which is why it is written as JavaScript.** A sandboxed preload (F§11) is
 * not a module — no bundler runs over what Chromium loads, and no `node_modules` are reachable from it — and the
 * shell's build emits this file as an asset beside the main bundle rather than as a bundle of its own
 * (`electron-vite` builds one preload entry, which is `src/preload/index.ts`, and
 * `src/main/capture/overlay-window.ts` ships this file with the `?asset` import suffix so the window can point
 * at it). So: no annotations, no `import`, `require("electron")` as a sandboxed preload is given it, and the two
 * channel names as literals — the other end of them is the pair of constants in
 * `src/main/capture/overlay-window.ts`.
 *
 * What the two members carry is not trusted because it came from here: the rectangle is validated against a
 * schema where it arrives, in the main process, because a renderer is a separate process with its own lifetime
 * and a channel carries whatever a script puts on it.
 */

/** The channels the two members send on: the names `overlay-window.ts` listens for. */
const OVERLAY_SUBMIT = "lectern:overlay-submit";
const OVERLAY_CANCEL = "lectern:overlay-cancel";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lecternOverlay", {
  // `submit(rect)` is `ipcRenderer.send` with the channel already bound, so the rectangle the page passes is
  // forwarded as it is and nothing here has to declare a parameter it would not be able to type anyway.
  submit: ipcRenderer.send.bind(ipcRenderer, OVERLAY_SUBMIT),
  cancel: ipcRenderer.send.bind(ipcRenderer, OVERLAY_CANCEL),
});
