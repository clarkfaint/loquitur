/**
 * Launching the shell for the end-to-end suite (F§10.3, F§13 phase 3).
 *
 * The suite drives the *built* application: Playwright's `_electron` starts the Electron binary on
 * `out/main/index.js`, which loads the copied `resources/web` — the same pair the packaging step ships. Every
 * launch gets a user-data directory of its own, so a case can never see a library, a profile or a lock an
 * earlier case left behind, and a case that launches the shell twice is genuinely launching *the same* shell
 * twice.
 *
 * `--no-sandbox` is passed only when `LECTERN_E2E_NO_SANDBOX` is set — that is, only when the host running the
 * suite has a reason to ask for it. Electron's own sandbox is a property of the machine (a setuid helper, or
 * user namespaces the kernel allows), not of the app, and Playwright adds the flag itself on Linux unless
 * `chromiumSandbox: true` is asked for. What F§10.3's `sandbox: true` governs — a renderer with no Node in it —
 * is asserted by the suite directly, and it holds either way.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, type Page } from "@playwright/test";

/** `apps/desktop`, from `apps/desktop/e2e`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The built main bundle: what `main` in `package.json` points at. */
export const MAIN_BUNDLE = join(PACKAGE_ROOT, "out", "main", "index.js");

/** Where `global-setup.ts` wrote the run's hub. */
const HUB_FILE = join(PACKAGE_ROOT, "e2e", ".hub.local");

/** The hub this run started, as `global-setup.ts` left it. */
export interface TestHub {
  baseUrl: string;
  token: string;
}

/** `testHub()` — the address and token of the run's own hub. */
export async function testHub(): Promise<TestHub> {
  return JSON.parse(await readFile(HUB_FILE, "utf8")) as TestHub;
}

/** The path of the Electron binary Playwright will use, for a launch made outside Playwright. */
export function electronPath(): string {
  return createRequire(import.meta.url)("electron") as string;
}

/** The arguments the shell is launched with: its own bundle, and `--no-sandbox` only when it was asked for. */
export function shellArguments(): string[] {
  return process.env["LECTERN_E2E_NO_SANDBOX"] === "1" ? ["--no-sandbox", MAIN_BUNDLE] : [MAIN_BUNDLE];
}

/** The arguments the second launch is started with: the same launch, made outside Playwright. */
export function secondLaunchArguments(): string[] {
  return process.platform === "linux" ? ["--no-sandbox", ...shellArguments()] : shellArguments();
}

/**
 * `closeApp(app)` — end the shell through its own quit path, then let Playwright go of it.
 *
 * Measured on this host: a case that has handed an address to the system browser cannot be torn down with
 * Playwright's `close()` alone — the OS handler starts a browser that never returns, and the browser's own close
 * command then never completes, so the case sits until its timeout. The app's own path does complete:
 * `app.quit()` fires `before-quit` (which is what lets the window be destroyed rather than hidden) and the
 * process exits in about half a second, after which `close()` resolves at once because there is nothing left to
 * close. Every case takes this route, so the suite has one teardown rather than two.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (!gone()) {
    await app
      .evaluate(({ app: shell }) => {
        shell.quit();
      })
      .catch(() => undefined);
    for (let waited = 0; waited < 10_000 && !gone(); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await app.close().catch(() => undefined);
}

/** The environment a launch runs with: this process's own, with the shell's user-data directory replaced. */
export function shellEnvironment(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["LECTERN_USER_DATA"] = userData;
  return env;
}

/** One running shell, as a case sees it. */
export interface LaunchedShell {
  /** The application, for facts only the main process knows. */
  app: ElectronApplication;
  /** The main window's page, for facts the reader can see. */
  window: Page;
  /** The directory this launch keeps everything in. */
  userData: string;
}

/** `launchApp()` — start the shell on the built bundle, with a user-data directory of its own. */
export async function launchApp(): Promise<LaunchedShell> {
  const userData = await mkdtemp(join(tmpdir(), "lectern-desktop-shell-"));
  const app = await electron.launch({ args: shellArguments(), env: shellEnvironment(userData) });
  const window = await app.firstWindow();
  return { app, window, userData };
}

/**
 * `openScreen(window, hash)` — move the app to one of its own screens.
 *
 * The shell's page is a file, so there is no base URL to be relative to: the address the window already holds
 * is the app, and only its hash changes.
 */
export async function openScreen(window: Page, hash: string): Promise<void> {
  const address = window.url();
  const withoutHash = address.includes("#") ? address.slice(0, address.indexOf("#")) : address;
  await window.goto(`${withoutHash}${hash}`);
}

/**
 * `connect(window)` — save the run's hub in the renderer, exactly as an operator would.
 *
 * There is no other way in: the settings screen is F§10.1's front door, and the shell's own import and playback
 * paths are behind it.
 */
export async function connect(window: Page): Promise<void> {
  const hub = await testHub();
  await openScreen(window, "#/settings");
  await window.getByLabel("Hub URL").fill(hub.baseUrl);
  await window.getByLabel("Token").fill(hub.token);
  await window.getByRole("button", { name: "Save" }).click();
  await expect(window.locator('[role="status"][data-status="connected"]')).toBeVisible();
}

/**
 * `emitAction(app, action)` — raise one action on the shell's bus, in the main process.
 *
 * This is the trigger the suite cannot press any other way: a global shortcut needs a window manager and a
 * consent dialog, and the tray needs a desktop. The bus is Electron's own `app` emitter (F§10.3), so raising an
 * action from the test is the same call a hotkey makes.
 */
export async function emitAction(app: ElectronApplication, action: string): Promise<void> {
  await app.evaluate(({ app: shell }, raised) => {
    shell.emit("lectern:action", raised);
  }, action);
}
