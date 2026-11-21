# Loquitur

*Res ipsa loquitur*: the thing speaks for itself.

Loquitur is an open-source, self-hosted read-aloud system for the documents you already own. It turns PDFs, EPUBs, Word files,
web articles and scanned pages into speech with engines running on your own hardware. While it reads, it highlights
each word and sentence in time with the audio. Your library, your reading position and your bookmarks follow you
across the web, a Chrome extension, a desktop app and an Android phone.

**Web** · **Chrome extension** · **Desktop (Linux, Windows)** · **Android**

---

## Why "Loquitur"?

*Loquitur* is Latin for **"it speaks."** It comes from the legal maxim *res ipsa loquitur*, "the thing speaks for
itself." In tort law, the doctrine applies when an accident speaks for itself: the event couldn't ordinarily have
happened without someone's negligence, so the facts carry the argument without further explanation.

That's what this app does for your reading. You hand it a document, and the document speaks for itself, in its own
words, at your pace, on any device you own.

The project started under the working name *Lectern*, the stand a reader reads aloud from. *Loquitur* keeps that
idea, but names what the app does rather than where the reading happens.

---

## Features

- **Reads almost anything:** PDF, EPUB, DOCX, plain text and web pages. Scanned PDFs and images go through OCR on
  the hub, and the Android app scans printed pages with on-device OCR.
- **Word-and-sentence highlighting** that follows the audio. Click any word to start reading from there.
- **Natural local voices:** [Kokoro](https://github.com/remsky/Kokoro-FastAPI) is always on, and
  [Piper](https://github.com/rhasspy/piper) is optional, with a voice picker across both.
- **Speed from 0.5× to 5.0×** with the pitch kept natural, plus a sleep timer, sentence skip and keyboard
  shortcuts.
- **Skips the clutter:** headers, footers, footnotes and bracketed citations aren't read aloud.
- **Sync across devices:** import on one device and the document, your place in it and your bookmarks appear on
  the others.
- **Offline listening:** download a document and it keeps playing with the hub unreachable.
- **AI summaries and key takeaways** from an OpenAI-compatible model you host yourself, and you can listen to the
  summary too. This is optional.
- **Per-platform extras:**
  - *Chrome:* read the page you're on, with a floating player.
  - *Desktop:* global hotkeys, read the text you selected in any app, read a region of the screen through OCR, a
    tray icon with a mini-player, and a watched inbox folder.
  - *Android:* background playback with lock-screen controls, share-to-app, and a multi-page camera scanner.

## Private by design

- **Single user, self-hosted.** There are no accounts, sign-ups or cloud services. One pre-shared token
  authenticates every client.
- **No telemetry**, analytics, crash reporting or update pings. The only network calls are to your own hub, and from
  the hub to the speech engines and the language model you configured.
- **Local-first clients.** Each one keeps its own library and syncs with the hub when it can reach it.

## How it fits together

```
apps/web        React single-page reader, with service-worker offline packs
apps/extension  Chrome MV3 extension (WXT): content script, shadow-DOM widget, offscreen audio
apps/desktop    Electron shell around the web reader, plus OS capture, hotkeys and the tray
apps/android    Expo / React Native: SQLite library, expo-audio playback, ML Kit scanning
      │  packages/ui-web        shared DOM components and the browser audio sink
      │  packages/core          document model, tokenizer, timing math, player, stores (isomorphic)
      │  packages/api-client    typed hub client, chunk caching, sync engine
      │  packages/api-contract  zod schemas for every route: one contract, both ends
      ▼  HTTP(S) + bearer token, and a WebSocket change feed for sync
apps/server     the hub: Fastify, SQLite (better-sqlite3), document parsers, TTS adapters
      └─ Kokoro-FastAPI · Piper (optional) · an OpenAI-compatible LLM (optional) · Caddy HTTPS (optional)
infra/          Dockerfile and docker-compose.yml: the hub and its engines
```

The stack is TypeScript throughout, built as a pnpm + Turborepo monorepo, with Biome for lint and format, Vitest
for unit tests and Playwright for end-to-end tests.

## Quick start

You need Node 24+ and pnpm. To check the rest of your machine (git, fonts, `xvfb-run` for the desktop tests, Java
and `adb` for Android, Docker for the stack), run:

```sh
node scripts/preflight.mjs --phase 5      # one OK/MISSING line per check
```

### 1. Run the hub (Docker)

```sh
cp -n infra/.env.example infra/.env       # git-ignored: your token never reaches the repository
$EDITOR infra/.env                        # set LECTERN_TOKEN to at least 32 random characters
docker compose -f infra/docker-compose.yml up -d --build --wait
curl -fsS http://127.0.0.1:8787/healthz   # {"ok":true,"version":"0.0.0","engines":["kokoro"]}
```

This starts the hub and Kokoro. The optional services are compose profiles:

- `--profile piper` adds a second voice engine.
- `--profile llm` turns on AI summaries.
- `--profile https` puts Caddy in front of the hub with its own local certificate authority. It also serves the
  web app and the client downloads over HTTPS.

Only the hub, and Caddy when you enable it, publish ports. Keep the stack on a private network or behind your own
VPN.

If you'd rather not use Docker, run `pnpm install --frozen-lockfile`, then `pnpm --filter @lectern/server dev`.
Backups, restores, cache pruning and upgrades are covered in [`docs/operations.md`](docs/operations.md).

Every client needs the same two things: **the hub's address and the token**.

### 2. Web app

```sh
pnpm install --frozen-lockfile
pnpm --filter @lectern/web run build
pnpm --filter @lectern/web exec vite preview    # http://127.0.0.1:4174
```

The first screen is Settings: enter the hub URL and the token, then press **Connect**. Import a file or paste
text, then press **Play**. For hot reloading during development, use `pnpm --filter @lectern/web run dev`.

### 3. Chrome extension

```sh
pnpm --filter @lectern/extension run build      # writes apps/extension/.output/chrome-mv3
```

In `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick
`apps/extension/.output/chrome-mv3`. Enter the hub URL and token in the popup, then press **Read this page** on
any article. PDF tabs are handed to the web app, which has the page view.

### 4. Desktop app

```sh
pnpm --filter @lectern/desktop run build        # the shell plus a copy of the web build
pnpm --filter @lectern/desktop run dist:linux   # AppImage + .deb in apps/desktop/dist/
```

To build for Windows, use `run dist:win` and follow [`docs/desktop-windows-build.md`](docs/desktop-windows-build.md).

### 5. Android app (sideload)

```sh
export ANDROID_HOME=~/android-sdk               # wherever your SDK lives
pnpm --filter @lectern/android run prebuild     # expo prebuild --platform android --clean
cd apps/android/android && ./gradlew :app:assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

Connect the app from its Settings tab. You can also send it a setup link, which fills in the form without ever
showing the token on screen:

```sh
adb shell am start -a android.intent.action.VIEW \
  -d 'lectern://setup?hubUrl=http://<hub-address>:8787&token=<your-token>'
```

`lectern://diagnostics` runs the on-device conformance checks and prints PASS or FAIL for each one.
[`docs/android-manual-checks.md`](docs/android-manual-checks.md) lists the checks that need a person: a scan, a
headset button, an incoming call.

## Testing

```sh
pnpm -w run lint && pnpm -w run typecheck && pnpm -w run test
node scripts/release-check.mjs                 # the full release gate, recorded in docs/release-check.json
node scripts/release-check.mjs --device        # also drives a physical phone over adb
node scripts/release-check.mjs --docker        # also runs a real-engine smoke test over compose
node scripts/e2e-cross-device.mjs              # two simulated devices syncing through a temporary hub
```

[`docs/parity-report.md`](docs/parity-report.md) maps each feature to the command in this repository that verifies
it.

## How it was built

Loquitur was built from a written specification, one small, verifiable unit at a time.

- [`features.md`](features.md) is the design of record: the document model, the timing math, the player state
  machine, the sync protocol, and the capability matrix in §4.
- [`spec.md`](spec.md) splits that design into numbered **unit contracts**. Each contract lists the files it may
  touch and has a fixed pass/fail command.
- The units were carried out by an AI coding agent working under the rules in [`AGENTS.md`](AGENTS.md). Evidence
  came first: every unit records its plan, the commands it ran and their real output in
  [`docs/evidence/`](docs/evidence/). The ledger in [`docs/status.md`](docs/status.md) indexes them.
- Guard scripts in [`scripts/`](scripts/) enforce what a machine can check: each unit's file scope, the read-only
  files and forbidden content.

It is a **clean-room** implementation. Its behaviour was specified in `features.md`, and no other product's code,
text, styles or assets were used. Third-party code comes in only as declared dependencies, pinned in
`features.md` §2.3.

## Status

The v1 scope is complete. These items are designed for but not built yet: chat with a document and AI quizzes,
translation, a pronunciation dictionary, and on-device synthesis without the hub. iOS, macOS and Safari are out of
scope.

## License

Loquitur is open source under the [MIT License](LICENSE). Its third-party dependencies keep their own
licences; the versions are pinned in `features.md` §2.3.

## Why the code still says `lectern`

Readers see the app as **Loquitur** (see [Why "Loquitur"?](#why-loquitur)). Package names
(`@lectern/*`), app IDs, environment variables (`LECTERN_*`), the `lectern://` link scheme and storage names keep
the original name on purpose: renaming them would make every installed client a new app and orphan its data.
[`docs/history-rewrite.md`](docs/history-rewrite.md) explains why the commit hashes quoted in the build records
differ from the ones in this history.
