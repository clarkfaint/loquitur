/**
 * The web app's entry point (F§10.1): load the settings, run every registered start-up feature once, and
 * mount the shell.
 *
 * Nothing renders until the reader's own settings are known, so the first paint is the screen the reader's
 * state asks for rather than a flash of the wrong one. The database is opened before a hub is configured —
 * the preferences live in it — while the start-up features wait for a connection, because there is nothing to
 * start against until one is saved (and the shell is on the settings screen until then).
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootFeatures } from "./boot";
import { getServices, getStorage } from "./services";
import { useSettingsStore } from "./settings/settings";

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
}

async function report(cause: unknown): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  // The shell never mounted, so the page itself is the only place left to say what happened.
  document.body.textContent = `Lectern could not start — ${message}`;
}

void start().catch(report);
