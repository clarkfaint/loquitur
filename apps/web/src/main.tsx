/**
 * The web app's entry point (F§10.1): load the settings, run every registered start-up feature once, and
 * mount the shell.
 *
 * Nothing renders until the reader's own settings are known, so the first paint is the screen the reader's
 * state asks for rather than a flash of the wrong one. The database is opened before a hub is configured —
 * the preferences live in it — while the start-up features wait for a connection, because there is nothing to
 * start against until one is saved (and the shell is on the settings screen until then).
 *
 * The offline worker is registered here as well, and for the same reason it is not a start-up feature: it
 * belongs to the *build* rather than to a connection, so it is handed to the browser whether or not a hub has
 * been saved (F§10.1).
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootFeatures } from "./boot";
import { getServices, getStorage } from "./services";
import { useSettingsStore } from "./settings/settings";

declare global {
  /**
   * The one Vite build flag this app reads. `vite/types/importMeta.d.ts` declares `import.meta.env` for a
   * program that loads `vite/client`, and this package's program deliberately does not; the flag it needs is
   * named here instead, and Vite replaces the expression inline at build time.
   */
  interface ImportMeta {
    readonly env: { readonly PROD: boolean };
  }
}

/**
 * `registerOfflineWorker()` — hand the browser the worker that keeps the app shell (F§10.1).
 *
 * Only a built app is registered, and only over `http` or `https`: a service worker needs a secure origin,
 * while the desktop shell loads the same files from `file://`, and the file list the worker precaches is one
 * `vite build` writes, so the dev server has nothing for it to keep. A failure is not fatal — the app works
 * with a network — so it is reported and the shell goes on loading.
 */
function registerOfflineWorker(): void {
  if (!import.meta.env.PROD) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  navigator.serviceWorker.register("./sw.js").catch((cause: unknown) => {
    console.warn(`the offline worker was not registered: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
}

/** The element `index.html` provides, or a failure that says so. */
function rootElement(): HTMLElement {
  const container = document.getElementById("root");
  if (container === null) throw new Error("index.html has no #root element");
  return container;
}

async function start(): Promise<void> {
  const container = rootElement();
  const storage = await getStorage();
  await useSettingsStore.getState().load(storage.store);

  if (useSettingsStore.getState().connection.hubUrl !== "") {
    const services = await getServices();
    for (const feature of bootFeatures) await feature(services);
  }

  createRoot(container).render(<App />);
  // Last, because a first paint is not worth delaying for a worker the browser can install afterwards.
  registerOfflineWorker();
}

async function report(cause: unknown): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  // The shell never mounted, so the page itself is the only place left to say what happened.
  document.body.textContent = `Loquitur could not start — ${message}`;
}

void start().catch(report);
