/**
 * The *packaged* application, end to end (F§10.3, F§13 phase 3).
 *
 * Every other desktop case drives the build directory — `out/main/index.js` beside `resources/`, which is what
 * `electron-vite build` leaves behind. This one drives what `dist:linux` writes: the unpacked application, with
 * its page and its preload read out of `resources/app.asar`. That is the only way to know the package is a
 * working application rather than a directory that happens to look complete, because the two differ in exactly
 * the places packaging breaks — the path the main process resolves its page from, the archive Electron reads it
 * out of, and the resource trees beside it.
 *
 * It is deliberately small. `scripts/verify-package.mjs` already checks the *shape* of the package; what a
 * browser can add is the behaviour: a window that loaded the app's own page from inside the archive, titled
 * `Lectern`, with the bridge reporting this platform. The full behavioural suite runs against the build
 * directory, where a failure points at one unit's code instead of at the packaging step.
 */

import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { closeApp, shellEnvironment } from "./launch";

/** `apps/desktop`, from `apps/desktop/e2e`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** What `electron-builder.yml`'s `directories.output` names, and the executable `productName` produces. */
const PACKAGED_EXECUTABLE = join(PACKAGE_ROOT, "dist", "linux-unpacked", "lectern");

/** What the page's own bridge reports: which platform, and how many members the shell exposed. */
function bridgeShape(page: Page): Promise<{ platform: string | null; members: number }> {
  return page.evaluate(() => {
    const held = (globalThis as { lecternDesktop?: Record<string, unknown> }).lecternDesktop;
    return { platform: (held?.["platform"] as string | undefined) ?? null, members: held === undefined ? 0 : Object.keys(held).length };
  });
}

test("the packaged application starts, and its page comes out of the archive", async () => {
  // The package is this case's input: without `dist:linux` there is nothing to launch, and saying so is more
  // useful than a launch error from Playwright.
  let packaged = false;
  try {
    packaged = statSync(PACKAGED_EXECUTABLE).isFile();
  } catch {
    packaged = false;
  }
  expect(
    packaged,
    `the packaged application is missing: ${PACKAGED_EXECUTABLE} — run \`pnpm --filter @lectern/desktop run dist:linux\` first`,
  ).toBe(true);

  // The packaged application is launched the way an operator launches it: the executable, with no argument at
  // all, and a user-data directory of its own so the case cannot see a library an earlier one left behind.
  const userData = await mkdtemp(join(tmpdir(), "lectern-desktop-packaged-"));
  const app: ElectronApplication = await electron.launch({
    executablePath: PACKAGED_EXECUTABLE,
    env: shellEnvironment(userData),
  });
  try {
    const window = await app.firstWindow();

    // The archive is the application directory here, which is what makes this a packaged run rather than the
    // build directory wearing a different path.
    const appPath = await app.evaluate(({ app: shell }) => shell.getAppPath());
    expect(appPath.endsWith("app.asar")).toBe(true);

    // F§10.3: the window is the app's own page, loaded from disk — and inside the archive, so the page really
    // did ship inside the package.
    expect(await window.title()).toBe("Loquitur");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toBe("Loquitur");
    expect(window.url()).toContain("app.asar");

    // F§10.3's bridge, on the platform this package was built for.
    const bridge = await bridgeShape(window);
    expect(bridge.platform).toBe("linux");
    expect(bridge.members).toBe(7);
  } finally {
    await closeApp(app);
  }
});
