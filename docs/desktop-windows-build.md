# Building Lectern for Windows

The NSIS installer is built on Windows. electron-builder cannot cross-build it from Linux, and an installer that
was never run is not a verified installer: everything below is what the operator does on a Windows machine, and
the status ledger records `windows: unverified` until those steps have really been run.

F§10.3 says Windows artifacts are built on Windows; this file is the recipe and the checklist that goes with it.

## 1. What you need

- **Windows 10 or 11, 64-bit.** The build also runs under a Windows virtual machine; no macOS or Linux step is
  involved.
- **Node.js 24 or newer** and **pnpm 12.18.0** (`npm install -g pnpm@12.18.0`, or `corepack enable` and the
  `packageManager` field in the repository root does the rest).
- **Git**, to get the tree onto the machine.
- About **5 GB** of free space: the Electron distribution, the NSIS toolchain and the unpacked application are all
  written under `apps/desktop/dist`.
- **A hub to point the app at** for the checklist in section 3 — the operator's own hub over the private network,
  or `infra/docker-compose.yml` on another machine. Nothing in the build or the installer needs it; the app's
  first screen does.

The first build downloads Electron and the NSIS toolchain from their own release servers, so it needs an internet
connection. Later builds reuse `%LOCALAPPDATA%\electron-builder\Cache`.

## 2. Build the installer

From the repository root, in PowerShell:

```powershell
pnpm install
pnpm --filter @lectern/web run build
pnpm --filter @lectern/desktop run build
pnpm --filter @lectern/desktop run dist:win
```

That is the whole build, and each step is a required input of the next one:

1. `pnpm install` links the workspace. Nothing is downloaded that the lockfile does not already name.
2. `apps/web`'s production build is what the shell shows; the desktop package never rebuilds it, it copies it.
3. `@lectern/desktop`'s build compiles the main process and the preload script into `apps/desktop/out` and copies
   the web build into `apps/desktop/resources/web`.
4. `dist:win` runs electron-builder with `--win nsis`, which packs `out/**` into `resources/app.asar`, copies the
   three resource trees beside it, and writes one installer.

The installer is written to **`apps/desktop\dist\`**, named `Lectern Setup 0.0.0.exe`. It is **not** signed: no
code-signing certificate is configured, Windows SmartScreen will show its "unknown publisher" prompt, and
"More info → Run anyway" is the expected path for the operator's own machine.

The installer is **per-user**: it installs into the current user's profile and never asks for elevation. Only the
installing user gets it, and no machine-wide state is written.

## 3. Manual checklist

Run every line of this on the machine that installed the build, and record the result. An unchecked line is
`UNKNOWN`, not a pass.

**Connect first.** Launch Lectern, and on the settings screen enter the hub's URL and its bearer token. The
status line must read as connected — the app checks both the hub's health probe and an authenticated route
(`voices`), so a wrong token reads as an error rather than as "connected".

| # | Check | Expected |
|---|---|---|
| 1 | **Install** | The per-user installer completes without a UAC prompt, and Start-menu → Lectern opens the window. |
| 2 | **Launch and reload** | The window opens with the reader UI, and pressing `Ctrl+R`-free: simply closing the window with the X hides it (the tray icon stays); the `showMain` hotkey or the tray's Show entry brings it back. |
| 3 | **Read selection — browser** | In a browser, select a paragraph, press `Ctrl+Alt+R`: a document arrives in the library's `Quick reads` folder, the mini-player appears with its title, and playback starts. |
| 4 | **Read selection — text editor, clipboard restored** | Copy some text in Notepad (or any editor), leave it on the clipboard, select a *different* paragraph there, and press `Ctrl+Alt+R`. The paragraph is read — and the clipboard still holds the text you copied before the hotkey. On Windows this path is a clipboard round trip: the app saves the clipboard, sends `Ctrl+C` to the foreground window, waits up to 400 ms for the clipboard to change, reads it, and puts the saved text back. |
| 5 | **Screen region** | Press `Ctrl+Alt+S`: the screen dims, drag a rectangle over some prose, and release. A document carrying the text in that rectangle appears in `Quick reads` and starts playing. Press `Esc` instead of dragging, and nothing is imported. |
| 6 | **Each default hotkey** | `Ctrl+Alt+Space` toggles play/pause, `Ctrl+Alt+Right` and `Ctrl+Alt+Left` skip a sentence, `Ctrl+Alt+Up` and `Ctrl+Alt+Down` move the rate by 0.1 within 0.5–5.0. The settings screen's hotkey rows show each one as *registered*. |
| 7 | **Mini-player** | The mini-player is a frameless strip that stays above other windows, moves where you drag it, and is still where you left it after the app is closed and reopened. Its play/pause and sentence buttons drive the reader window. |
| 8 | **Watched folder** | In `%USERPROFILE%\Lectern\Inbox`, drop a PDF (or a `.docx`, `.epub`, `.txt`, `.md`, `.html`). Within a few seconds it appears in the library's `Inbox` folder. Re-copying the same file does not add a second document, and a file being written (a `.part` or `~$` file) is ignored until it is complete. |
| 9 | **Tray** | The tray icon is present with Play/Pause, next/previous sentence, Show/Hide and Quit. Play/Pause follows the player's own state, and Quit ends the application — the only entry that does. |
| 10 | **Uninstall** | "Apps & features" removes it without elevation, and the operator's library, settings and cached audio in the user-data directory are left alone. |

**What is deliberately absent.** No auto-start entry, no file association, no protocol handler, no background
service, no update feed and no telemetry. If a build ever creates one of those, the build is wrong.

## 4. When something fails

- **A hotkey does nothing.** Check the settings screen's hotkey rows first: a chord another application already
  holds is reported as *failed* there rather than silently doing nothing.
- **"Read selection" reads nothing.** The Windows path drives the foreground window, so the source window must be
  the one in front when the hotkey is pressed. A source that does not answer `Ctrl+C` yields a visible
  notification, not a silent no-op.
- **The region window is empty or black.** Some graphics drivers refuse a desktop capture over a full-screen
  application; retry with the target windowed.
- **The installer refuses to overwrite a running copy.** Quit from the tray first: the tray's Quit is the only
  entry that ends the application, and the window's X deliberately does not.
- **The build downloads nothing and fails.** The first build needs the network; confirm that
  `%LOCALAPPDATA%\electron-builder\Cache` is writable.
