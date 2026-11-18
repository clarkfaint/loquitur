# Lectern

Lectern is a read-aloud system for documents you already own: it parses them, synthesizes speech with engines
running on your own machine, and reads them to you with word-and-sentence highlighting that follows the audio. A
hub holds the parsing, the engines, the audio cache, the library and the sync; four clients read from it — a web
app, a Chrome extension, a desktop application and an Android app — and a document you import on one of them
appears on the others, with the place you stopped and the bookmarks you made.

It is a **single-user, personal tool**. There are no accounts, sign-up, roles or sharing; authentication is one
pre-shared bearer token (`features.md` F§11). There is no telemetry, analytics, crash reporting or update ping,
and the only outbound calls any part of Lectern makes are to your hub and, from the hub, to the engines and the
language model you configured. It is open source and clean-room: every line was written from the behaviour
descriptions in `features.md`, not from another product's code. iOS, iPadOS, macOS and Safari are out of scope by
requirement.

## Architecture, in ten lines

```
apps/web        React single-page reader + service-worker offline packs         F§10.1
apps/extension  WXT/MV3: content script, shadow-DOM widget, offscreen audio      F§10.2
apps/desktop    Electron shell that loads the web build, plus OS capture/tray    F§10.3
apps/android    Expo/React Native app: SQL store, expo-audio sink, ML Kit scan   F§10.4
      │  packages/ui-web      shared DOM components and the browser audio sink
      │  packages/core        document model, tokenizer, timing, player, stores (isomorphic)
      │  packages/api-client  typed hub client, caching ChunkSource, SyncEngine
      │  packages/api-contract zod schemas for every route — one contract, two ends
      ▼  HTTPS + bearer token, and a WebSocket change feed for sync
apps/server     the hub: Fastify, better-sqlite3, the Node-only parsers, TTS adapters
      └─ Kokoro-FastAPI · Piper (optional profile) · an OpenAI-compatible LLM (optional profile)
infra/          Dockerfile and docker-compose.yml — the hub plus its engines
```

`features.md` is the architecture of record: the numbered sections (`F§4`'s parity matrix, `F§5`–`F§11`'s
designs) are what the code implements, and `spec.md`'s unit contracts are how it was built, one unit at a time,
with `docs/status.md` as the ledger. `docs/parity-report.md` says which of those capabilities a command in this
repository verifies, and `docs/operations.md` is the operator's guide to running the hub.

## Quick start

Node 24 and pnpm are what the workspace is built with (`node --version` ≥ 24); `scripts/preflight.mjs` checks the
rest of a host — `pnpm`, `git`, a system font, `xvfb-run` for the desktop tests, Java and `adb` for Android,
Docker for the stack:

```sh
node scripts/preflight.mjs --phase 5      # one OK/MISSING line per check; writes docs/preflight.json
```

### 1. The hub (Docker, one command)

```sh
cp -n infra/.env.example infra/.env       # git-ignored: your token never reaches the repository
$EDITOR infra/.env                        # set LECTERN_TOKEN to at least 32 random characters
docker compose -f infra/docker-compose.yml up -d --build --wait
curl -fsS http://127.0.0.1:8787/healthz   # {"ok":true,"version":"0.0.0","engines":["kokoro"]}
```

That starts the hub and Kokoro, its always-on engine. Piper and the AI endpoint are optional profiles
(`--profile piper`, `--profile llm`), and every engine is reachable on the compose network alone — only the hub
publishes a port. Without Docker, a checkout runs the same hub: `pnpm install --frozen-lockfile` then
`pnpm --filter @lectern/server dev`. Backups, restores, cache pruning, the private-network rules and the upgrade
path are in `docs/operations.md`.

Every client needs two things: the hub's address and the token. Point them at `http://127.0.0.1:8787` on the
machine running the hub, or at whatever address your own VPN gives it — the stack has no TLS, so keep it on a
private network.

### 2. The web app

```sh
pnpm install --frozen-lockfile
pnpm --filter @lectern/web run build
pnpm --filter @lectern/web exec vite preview    # http://127.0.0.1:4174
```

Open it, and the first screen is Settings: paste the hub's URL and the token, and press Connect. Import a file
from the toolbar, or paste text, and press Play. A browser reload restores the position you left, and a document
you asked to keep offline keeps working with the hub unreachable. `pnpm --filter @lectern/web run dev` is the
hot-reloading variant.

### 3. The Chrome extension

```sh
pnpm --filter @lectern/extension run build      # writes apps/extension/.output/chrome-mv3
```

In Chrome open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick
`apps/extension/.output/chrome-mv3`. Open the extension's popup, enter the hub URL and token, and press
**Read this page** on any article: the page is parsed, played through the extension's own offscreen audio, and
the floating widget follows the sentence being read. PDF tabs are handed to the web app, which has the page view.

### 4. The desktop app

```sh
pnpm --filter @lectern/desktop run build        # the shell plus a copy of the web build
pnpm --filter @lectern/desktop run dist:linux   # AppImage + .deb in apps/desktop/dist/
```

Run the AppImage, or install the `.deb`. The shell loads the same reader as the web app and adds what only a
desktop process can: global shortcuts, reading the text you selected anywhere, reading text out of a captured
region of the screen, a tray icon and a frameless mini-player. `pnpm --filter @lectern/desktop run dev` is the
development run. Windows builds with `run dist:win`; the steps and the checks a person has to make on Windows are
in `docs/desktop-windows-build.md`.

### 5. The Android app (sideload)

```sh
export ANDROID_HOME=~/android-sdk        # wherever your SDK lives
pnpm --filter @lectern/android run prebuild     # expo prebuild --platform android --clean
cd apps/android/android && ./gradlew :app:assembleRelease
adb install -r apps/android/android/app/build/outputs/apk/release/app-release.apk
```

Then point the app at the hub. The quickest way is the app's own link, which fills the connection form without
ever drawing the token on screen:

```sh
adb shell am start -a android.intent.action.VIEW \
  -d 'lectern://setup?hubUrl=http://127.0.0.1:8787&token=your-token'
```

(On a physical phone, replace `127.0.0.1` with the hub's address on your network — or use
`adb reverse tcp:8787 tcp:8787`, which is what the device checks in this repository do.) The same form lives in
the app's Settings tab, and `lectern://diagnostics` runs the on-device conformance checks and prints a
`PASS`/`FAIL` line for each. The Android app reads with `expo-audio` in a media-playback foreground service
(background playback and lock-screen controls), keeps its library in SQLite, imports through the hub, scans
printed pages with ML Kit, and accepts shares from other apps. `docs/android-manual-checks.md` lists the checks
that need a person's hands, eyes and ears — a scan, a headset button, an incoming call — and what each should
look like.

## Verifying a build

```sh
node scripts/release-check.mjs                 # every step, with a record in docs/release-check.json
node scripts/release-check.mjs --device        # also drives a physical phone through adb
node scripts/release-check.mjs --docker        # also runs the real-engine smoke test over compose
node scripts/e2e-cross-device.mjs              # two simulated devices against a temporary hub (F§8, F§9)
```

`node scripts/preflight.mjs --phase 5`, the workspace tasks (`pnpm -w run lint|typecheck|test`), the four guard
scripts in `scripts/` and `docs/parity-report.md` are the rest of it. A per-unit account of what was built and
what it proved is in `docs/evidence/`, indexed by `docs/status.md`.

## Licence and provenance

Lectern is a clean-room implementation: its behaviour is specified in `features.md`, and the reference product
was never used as a source of code, text, styles or assets. Third-party open-source code enters only as a
declared dependency, at the exact versions in `features.md` F§2.3. The guards in `scripts/` enforce the parts of
that which a machine can check — the name, the platforms left out, the read-only files and the scope of each
unit's changes.
