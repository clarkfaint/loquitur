#!/bin/sh
# The sync check (U-061, F§8, F§10.4).
#
# What F§8 promises is that a record written on one device reaches another, and that is what this script
# measures from the other side of the phone: `push-document.mjs` parses a five-sentence text through the
# local hub, uploads the model and pushes one `document` op under a device identifier of its own — a record
# written by *another device* — and the check then requires that document's title to appear in the app's own
# library, and the app's own `sync-roundtrip` row to report `PASS`.
#
#   1. a mock-engine hub is started on the loopback interface with the `adb reverse` that lets the device
#      reach it (the harness's own, exactly as `run-all.sh` starts one; this script runs after that script
#      has taken its own hub down);
#   2. the app is brought up on its library — a cold start, the path a reader who taps the icon takes, which
#      is also what starts U-061's sync service and runs F§8.3's start round — and the library's own control
#      is required to be on the screen, which is what "the app is connected and in the foreground" means
#      here;
#   3. the push happens;
#   4. the title is required to appear in the library within the contract's 30 s. The app is brought up again
#      inside that window if it has to be: the library reads F§5.9's store when it comes into focus (the
#      screen's own `useFocusEffect`), so a round that landed after the list had drawn is seen by a fresh
#      start — which is also F§8.3's own "pull when the app comes up";
#   5. `lectern://diagnostics?autorun=1` is opened and the app's own `sync-roundtrip` row is required to say
#      `PASS` — the round trip from the *device's* side, against the same hub, which is the half the title
#      cannot prove (a title proves a pull; the row proves a push, an empty outbox and a moved cursor).
#
# The hub and the port reverse are taken down on every exit path, including a failure and an interrupt, so
# the device is left as it was found. Nothing is written outside `data/device-run/` and no system setting is
# changed (AGENTS.md §7).
#
# Usage: sh apps/android/scripts/device/verify-sync.sh   (it starts and stops its own hub)

. "$(dirname -- "$0")/lib.sh"

# The contract's own window for the pushed document to reach the library, in seconds.
SYNC_WINDOW=30

# How long the app is given to come up on its library, and how many times the start is tried.
LIBRARY_BUDGET=30
LIBRARY_ATTEMPTS=3

# How long the app is given between a start and the look that follows it.
BOOT_PAUSE=6

# How long the diagnostics run is given to reach this unit's row. The registry runs the five checks the
# earlier units registered before this one's, and two of them are conformance suites against the device's own
# SQLite and audio queue, so this is a ceiling rather than an expectation (U-052's own budget).
DIAGNOSTICS_BUDGET=180

# How long the app is given between a start and the look that follows it.
BOOT_PAUSE=5

hub_started=0

# The first node whose *drawn text* carries the wanted string, as a `ui_nodes` line. A row's title is text; a
# control's label is `content-desc`, and the two are asked for separately so that a document's title can never
# be confused with a control beside it (the shape `verify-offline.sh` uses; `lib.sh` is U-052's frozen file).
node_with_text() {
  ui_nodes | awk -F'\t' -v want="$1" 'index($1, want) > 0 { print; exit }'
}

# `start_app` — force-stop the app and start it the way the launcher does, which is a fresh mount of every
# screen and a fresh start of the sync service.
start_app() {
  "$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1
  "$ADB" shell am start -n "$PACKAGE/.MainActivity" >/dev/null 2>&1 || true
}

# `open_library` — the app is up with its library in front of the reader.
#
# Two steps, because the two answer different halves of "the library is on the screen": a cold start is the
# path a reader who taps the icon takes, which is also what starts U-061's sync service and runs F§8.3's start
# round, and the app's own library address is the route that draws (the entry route reads the connection
# asynchronously and redirects from `/`, so which screen a bare start lands on is not this script's to assume —
# measured: a force-stopped app started with the launcher alone once took longer than the whole budget to show
# the library, while the same start followed by the app's own address reached it inside the first look).
# Both are retried, because a device paints at its own pace.
open_library() {
  attempt=1
  while [ "$attempt" -le "$LIBRARY_ATTEMPTS" ]; do
    note "open_library: bringing $PACKAGE up on its library (attempt $attempt of $LIBRARY_ATTEMPTS)"
    start_app
    sleep 2
    open_link "lectern://library" || true
    waited=0
    while [ "$waited" -lt "$LIBRARY_BUDGET" ]; do
      if [ -n "$(node_with_text "Import")" ]; then
        note "open_library: the library is on the screen after ${waited}s"
        return 0
      fi
      sleep 3
      waited=$((waited + 3))
    done
    attempt=$((attempt + 1))
  done
  fail "open_library: the app never came up on its library within ${LIBRARY_BUDGET}s per attempt"
  return 1
}

# `wait_for_library_title <title>` — F§8's record reaches the library inside the contract's window. Each pass
# looks at the screen and, when the title is not there yet, brings the app up on its library again: a fresh
# mount re-reads F§5.9's store and a fresh start runs F§8.3's round once more, which is the app's own path to
# both.
wait_for_library_title() {
  want=$1
  waited=0
  while [ "$waited" -lt "$SYNC_WINDOW" ]; do
    if [ -n "$(node_with_text "$want")" ]; then
      note "wait_for_library_title: \"$want\" is in the library after ${waited}s"
      return 0
    fi
    start_app
    sleep 2
    open_link "lectern://library" >/dev/null 2>&1 || true
    sleep "$BOOT_PAUSE"
    waited=$((waited + BOOT_PAUSE))
  done
  fail "wait_for_library_title: \"$want\" never appeared in the library within ${SYNC_WINDOW}s"
  return 1
}

# Whatever happens from here on, the hub and the reverse go away.
cleanup() {
  if [ "$hub_started" = "1" ]; then
    hub_started=0
    if ! stop_hub; then
      fail "verify-sync: stop_hub could not confirm the hub is gone"
    fi
  fi
}
trap cleanup EXIT INT TERM

require_device || exit 1

# 1. The hub this check reads with, and the reverse that lets the device reach it.
start_hub || exit 1
hub_started=1

# 2. The app, connected and in the foreground, on the library the pushed record has to appear in.
open_library || exit 1

# 3. The push: another device's document, its model, and one `document` op.
note "verify-sync: running push-document.mjs against $HUB_URL"
title=$(node "$DEVICE_DIR/push-document.mjs" "$HUB_URL" "$HUB_TOKEN" 2>"$RUN_DIR/push-document.log")
pushed=$?
if [ "$pushed" -ne 0 ] || [ -z "$title" ]; then
  fail "verify-sync: push-document.mjs exited $pushed without a title — what it said:"
  cat "$RUN_DIR/push-document.log" >&2 || true
  exit 1
fi
note "verify-sync: pushed \"$title\" (the script's own log is in $RUN_DIR/push-document.log)"

# 4. The title, in the library, inside the contract's window.
if ! wait_for_library_title "$title"; then
  fail "verify-sync: what the library is showing instead:"
  ui_nodes | awk -F'\t' '$1 != "" { print "  " $1 }' | head -20 >&2
  exit 1
fi

# 5. The device's own round trip: a setting written, pushed, pulled, and the outbox and cursor read back.
note "verify-sync: opening lectern://diagnostics?autorun=1 and requiring PASS sync-roundtrip (budget ${DIAGNOSTICS_BUDGET}s)"
open_link "lectern://diagnostics?autorun=1" || exit 1

elapsed=0
found=0
while [ "$elapsed" -lt "$DIAGNOSTICS_BUDGET" ]; do
  rows=$(ui_nodes | awk -F'\t' '{ print $1 "\n" $2 }')
  if printf '%s\n' "$rows" | grep -qF "PASS sync-roundtrip"; then
    found=1
    break
  fi
  failed=$(printf '%s\n' "$rows" | grep -F "FAIL sync-roundtrip" || true)
  if [ -n "$failed" ]; then
    fail "verify-sync: the app's own sync-roundtrip row says FAIL after ${elapsed}s:"
    printf '%s\n' "$rows" | grep -A 2 "sync-roundtrip" | sed 's/^/  /' >&2
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
if [ "$found" -eq 0 ]; then
  fail "verify-sync: no PASS sync-roundtrip row within ${DIAGNOSTICS_BUDGET}s — the rows on the screen:"
  printf '%s\n' "$rows" | grep -F "PASS " | sed 's/^/  /' >&2
  printf '%s\n' "$rows" | grep -F "FAIL" | sed 's/^/  /' >&2
  exit 1
fi

printf '%s\n' "$rows" | grep -A 2 "sync-roundtrip" | sed 's/^/verify-sync: /' | sort -u

note "verify-sync: the pushed document is in the library and the device's own round trip reports PASS sync-roundtrip"
