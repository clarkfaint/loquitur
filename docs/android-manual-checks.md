# Android manual checks

The checks the device harness cannot make for us, and what a person should see when they make them.

`apps/android/scripts/device/run-all.sh` and `verify-offline.sh` drive the app through `adb` and read the
platform's own answers, so they cover the things a machine can observe: the on-device conformance suites, a
share intent reaching the app, the media session's state, offline playback with the hub stopped. The list below
is what is left — the checks that need a person's hands, eyes and ears, a second app, or a call to arrive.

Run them on a physical device with the release APK installed and a hub reachable. The hub can be this
repository's own, started the way the harness starts it:

```sh
cd apps/server && LECTERN_TOKEN=lectern-hub-test-token-0123456789 LECTERN_ENABLE_MOCK=1 \
  LECTERN_PORT=8787 LECTERN_DATA_DIR=../data/manual-checks/hub node_modules/.bin/tsx src/main.ts
```

With a real engine configured (F§7.1) the audio is the real thing and the timings below are worth reading; with
the mock engine the checks still prove the plumbing. Set the connection up once, in Settings or through
`lectern://setup`, and confirm it with the diagnostics screen before starting.

A note on the numbers: the ranges below are what this project's own build does on a mid-range Android phone.
A slower device stretches them; what matters is that each check *happens*, in the order described, without the
reader having to poke at the app.

## 1. Scan a three-page printed document and listen

1. Print three pages of ordinary body text — one column, black on white, nothing in the margins — and lay them
   somewhere flat and evenly lit.
2. Open the Scan tab, start a scan, and take all three pages.
3. Watch the page count and the previews, then press Save and listen.

**Expected:** each page is captured in turn, the sheet shows three pages with a preview each, and Save and
listen puts the document in the library with a title of `Scan <date> <time>` and opens the reader on it. The
first page's first sentence is read within a few seconds. The document holds three pages in page order — the
top of page 1 first and the bottom of page 3 last — and the OCR text has no page's opening line attached to the
page before it. Camera permission is asked for once and never again.

## 2. Share a web page from the browser

1. Open an article in the browser on the device — a long one, several paragraphs.
2. Share it with Lectern (the share sheet, or the browser's own menu).

**Expected:** Lectern opens on the Shared with Lectern screen, says it is resolving, and then lists one action
for the address. Pressing the import takes the reader to the article, and its first sentence is read aloud. The
library then holds it under the hub's own title for that address, and reopening it from the library needs no
network beyond the hub.

## 3. Share a PDF from a file manager

1. Put a text-based PDF (not a scan) in the device's Downloads folder.
2. Open the file manager, long-press the PDF, and share it with Lectern.

**Expected:** the Shared with Lectern screen lists one file action naming the PDF. The import runs through the
hub and the reader opens on the PDF's text, in order, from the first page to the last. A scanned PDF — pages of
pictures with no text layer — is expected to produce the hub's own failure sentence rather than an empty
document; try the same file through the scanner instead.

## 4. Lock-screen controls on a physical device

1. Open a document in the reader and press Play.
2. Press the power button to lock the device, then look at the lock screen.
3. Use the lock screen's own controls: pause, play, next sentence, previous sentence.

**Expected:** the lock screen and the notification both show the document's title and the sentence now playing,
and they follow the reading as it moves. Pause stops the audio within a second; play resumes from the sentence
the reader was on, not from the beginning; next and previous move exactly one sentence and keep playing. The
transport stays on the lock screen the whole time the reading is alive, and disappears once the reader is
closed.

## 5. Headset button play/pause

1. Connect a wired headset, or a Bluetooth one, with a play/pause button.
2. Start a reading, then press the button, then press it again.

**Expected:** the first press pauses the reading; the second resumes it at the same sentence. The audio does not
jump back to the start of the sentence, and the media session's own state follows the button (the lock screen
shows paused, then playing). A double press may be handled by the headset's own firmware as a skip; if it is,
the reading must move one sentence rather than stop.

## 6. An incoming call pauses playback

1. Start a reading on a device with a SIM, or with a second app that can place a call to it.
2. Call the device and let it ring through to the lock screen.
3. Answer, talk for a moment, and then hang up.

**Expected:** the reading pauses the moment the call is offered — not after it is answered — and does not come
back by itself while the call is up. When the call ends, the reading stays paused: the reader presses play to
resume, and it resumes at the sentence they were on. Nothing is read aloud into the call at any point.

## 7. Playback at 4.5×

1. Open a document with at least a page of text and start it playing.
2. Set the rate to 4.5× — the reader's own presets include it — and let it play for a while.
3. Move the rate back to 1×.

**Expected:** the reading is noticeably faster without changing pitch — the voice stays the same voice rather
than rising in tone — and the sentence highlight keeps up with the audio. The time remaining in the player bar
falls at the rate the reader chose. The progress record survives: locking the device and coming back leaves the
reader where the speech is, not where it was before the speed change. F§5.6(e) allows the rate to be split
between the engine and the sink; with the mock engine and the platform's own ceiling the split happens inside
the sink, so no chunk is re-synthesized and the reading never pauses to fetch a faster one.
