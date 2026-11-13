# Inspection targets — operator instructions

Inspection gathers behavioural evidence about the reference product so that Lectern can match the
*behaviour* it is compared against. It is advisory: every Unit Contract is buildable from
`features.md` alone, and a missing target is never a blocker — the unit records
`Inspection: UNAVAILABLE (<reason>)` and continues.

Everything under `targets/` is gitignored except this file and `targets/probe/`. Never commit an
artifact here, never put a credential here, and never point an agent at a target it was not given.

## 1. Reference web reader and extension (`T-WEB`, `T-EXT-RUN`)

Start the browser once, by hand, with **your own** profile directory and the debug port open:

```sh
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/reference-inspection-profile"
```

- Sign in yourself. The executor never signs in, never changes an account or billing setting, and
  never touches anything outside the probe content.
- Open the reference reader and load the probe text: import **`targets/probe/probe.txt`**.
- For in-page work (`U-033`, `U-035`, `U-036`), serve the probe directory first and leave it
  running, then open the article page in the same browser:

```sh
node targets/probe/serve.mjs
# then open http://127.0.0.1:4173/article.html
```

- Leave the tab open and paused where you want the inspection to start.

## 2. Reference extension package (`T-EXT-PKG`)

Copy the installed extension's directory to `targets/extension/`:

```sh
mkdir -p targets/extension
cp -r "<path to the installed extension directory>" targets/extension/
```

Only `targets/extension/manifest.json` is ever read directly, and only for declarations.

## 3. Reference Windows application (`T-WIN`)

Copy the package or install directory to `targets/desktop-win/`. This must be done on a Windows
machine; nothing is downloaded.

## 4. Reference Android package (`T-APK`)

Pull the package from your own device:

```sh
adb shell pm path <package>
adb pull <path reported above> targets/android/base.apk
```

## 5. Screenshots and screen recordings (`T-SHOTS`)

Put operator-made images under `targets/shots/<platform>/` — for example
`targets/shots/desktop/`, `targets/shots/android/`. These are viewed directly; no tooling is used.

## 6. Which probe file to load, and when

| Unit(s) | Load this | Why |
| --- | --- | --- |
| `U-003`, `U-012`, `U-013`, `U-023`, `U-024`, `U-025`, `U-029` | `targets/probe/probe.txt` in the reader | Splitting, highlighting, speed, seek, and player-state behaviour |
| `U-007`, `U-030` | `packages/fixtures/generated/text.pdf` once `U-005` has produced it | Paged documents, anchors, and skip behaviour |
| `U-033`, `U-035`, `U-036` | `http://127.0.0.1:4173/article.html` (extension active) | In-page extraction, highlighting, and the floating player |
| `U-032`, `U-034`, `U-037` | `targets/extension/manifest.json` only | Declared contexts, permissions, and commands |
| `U-038`, `U-040`, `U-041`, `U-042`, `U-044` | `targets/desktop-win/` | Package shape, imported API families, resource types |
| `U-039`, `U-048`, `U-049`, `U-052`, `U-065` | `targets/shots/desktop/`, `targets/shots/android/` | Compact player, tray menu, reading screen, lock-screen controls |
| `U-045`, `U-047`, `U-050`, `U-051`, `U-053` | `targets/android/base.apk` | SDK levels, permissions, exported components, library families |

Two units need the probe page and a fixture at the same time only when you choose to open both;
the executor is told exactly which single target each unit may use.

## 7. Ground rules

- One target per unit. The executor never inspects a second platform "while it is there".
- The probe files in `targets/probe/` are original Lectern test text and are the only content ever
  loaded into the reference product.
- Do not record endpoints, request bodies, tokens, cookies, class names, or asset URLs in evidence.
- `node scripts/preflight.mjs --targets` prints which of these paths currently exist.
