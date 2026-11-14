/**
 * The extension's browser-test fixtures (F§10.2).
 *
 * Every case in this package needs the same three things before it can do anything: a browser with the *built*
 * extension loaded, the worker that extension started, and the run's hub written into the extension's settings.
 * They are fixtures rather than shared code because each is a resource with a lifetime — the browser is closed
 * when the case ends, and the worker is waited for rather than assumed.
 *
 * Two measured facts decide the launch shape. An unpacked extension is only loaded into a *persistent* context,
 * so the `context` fixture below is one created with `launchPersistentContext` rather than Playwright's default;
 * and it passes `channel: "chromium"` because Playwright's default headless binary is the headless shell, which
 * loads no extension at all — with the channel, the full browser runs headless with the extension live.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type BrowserContext, test as base, chromium, type Worker } from "@playwright/test";

export { expect } from "@playwright/test";

/** The built extension a case loads: what `wxt build` wrote, which is what the unit's command builds first. */
const EXTENSION = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));

/** Where `global-setup.ts` wrote this run's hub and page server. */
const ENV_FILE = fileURLToPath(new URL("./.env.local", import.meta.url));

/** The voice F§7.1's mock engine answers to, which is what a case reads with. */
export const MOCK_VOICE_ID = "mock:mock-a";

/** What this run's `global-setup.ts` wrote. */
export interface TestEnvironment {
  hubUrl: string;
  token: string;
  pagesUrl: string;
}

/** The settings a case runs with, when it does not name its own. */
export interface ExtensionSettings {
  hubUrl: string;
  token: string;
  voiceId: string;
  rate: number;
}

/** Read the run's addresses and token. */
export async function testEnvironment(): Promise<TestEnvironment> {
  const text = await readFile(ENV_FILE, "utf8");
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const read = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`${ENV_FILE} holds no ${key}; is the run's globalSetup configured?`);
    return value;
  };
  return { hubUrl: read("LECTERN_HUB_URL"), token: read("LECTERN_TOKEN"), pagesUrl: read("LECTERN_PAGES_URL") };
}

export const test = base.extend<{
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  configure: (overrides?: Partial<ExtensionSettings>) => Promise<void>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a fixture's first argument to be a destructuring pattern, and this one takes no dependencies.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        // A case starts playback by script rather than by a control, so the browser must not demand a gesture.
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const [started] = context.serviceWorkers();
    await use(started ?? (await context.waitForEvent("serviceworker")));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  /**
   * `configure(overrides?)` — point the extension at this run's hub, as the popup's form does, and prove the
   * write by reading the record back.
   *
   * The settings record is written from the worker because that is the one context both the popup and the
   * offscreen document's settings channel ultimately read from. The origin is requested on the way, because
   * that is what F§11's flow does — and it is requested without a user gesture, which this platform refuses at
   * once; a request *with* a gesture hangs on a prompt nothing in this rig can dismiss (measured). The hub is
   * reachable either way: the extension's page fetches it under U-019's own CORS policy, which allows this
   * origin and the `authorization` header.
   */
  configure: async ({ serviceWorker }, use) => {
    await use(async (overrides = {}) => {
      const environment = await testEnvironment();
      const settings = {
        hubUrl: overrides.hubUrl ?? environment.hubUrl,
        token: overrides.token ?? environment.token,
        webAppUrl: "",
        voiceId: overrides.voiceId ?? MOCK_VOICE_ID,
        rate: overrides.rate ?? 1,
        autoShowWidget: false,
        disabledSites: [],
        skipFurniture: true,
      };
      const written = await serviceWorker.evaluate(async (value) => {
        await chrome.storage.local.set({ "lectern.extension.settings": value });
        await chrome.permissions.request({ origins: [`${new URL(value.hubUrl).origin}/*`] }).catch(() => false);
        const stored = await chrome.storage.local.get("lectern.extension.settings");
        return stored["lectern.extension.settings"] ?? null;
      }, settings);
      if (written === null) throw new Error("the settings record was not written to chrome.storage.local");
    });
  },
});
