#!/bin/sh
# The on-device conformance run (U-052, F§10.4).
#
# The app's diagnostics screen runs whatever its registry holds, and the five checks registered there are what
# this script reads: `core-selftest` (F§5.2, F§5.3 and F§5.6's goldens on the device's own engine),
# `hub-health` (F§7.2's probe plus one authenticated route, so a wrong token cannot read as a healthy hub),
# `library-store` and `blob-cache` (F§5.9's suites against the device's own SQLite and file system) and
# `audio-sink` (F§5.8's suite against the real `expo-audio` playlist).
#
# The connection is provisioned the way the contract asks: the app's own `lectern://setup` link, carrying the
# harness hub's address and token, and then the Connect button the reader would press. Nothing is typed and no
# field is written directly — the screen is the only thing that saves a connection, so a passing run proves the
# deep link and the button both work.
#
# Passes only when every one of the five ids reports `PASS` and no `FAIL` text is on the screen at all, which is
# the contract's own wording. A row that says FAIL is printed with the failure and the run stops there: nothing
# is retried, because a check that answered has answered.
#
# Usage: sh apps/android/scripts/device/verify-diagnostics.sh   (a hub must be running; run-all.sh starts one)

. "$(dirname -- "$0")/lib.sh"

# The contract's own budget for the whole run. The five checks include two conformance suites and a real audio
# queue, so this is a ceiling rather than an expectation.
BUDGET_SECONDS=180

# The five ids, in the order the registry runs them.
CHECK_IDS="core-selftest hub-health library-store blob-cache audio-sink"

require_device || exit 1

# 1. The connection: the contract's own link, then the button.
#
# The link is opened twice, and the whole sequence is retried, because of a measured behaviour of the app rather
# than a reader's: a cold start whose initial address carries a query string draws nothing at all, and whichever
# screen a deep link does open is replaced by the entry route's own redirect a few seconds later. So the bare
# link brings the setup screen up, the link carrying the hub's address and token fills it in, and the button is
# pressed while it is on screen — and if any of that misses its window, the sequence starts again. Both links are
# the contract's own deep link, and the button is still the only thing that saves anything.
provisioned=0
attempt=1
while [ "$attempt" -le 3 ] && [ "$provisioned" -eq 0 ]; do
  note "verify-diagnostics: provisioning the connection (attempt $attempt of 3)"
  if open_link "lectern://setup" && wait_for_text "Connect to a hub" 30 &&
    open_link "lectern://setup?hubUrl=$HUB_URL&token=$HUB_TOKEN" && wait_for_text "$HUB_URL" 15 &&
    tap_text "Connect"; then
    # The setup screen hands over to the tab group's settings screen once the connection is written, so the
    # button leaving the screen is the immediate confirmation; the hub-health row below is what proves the
    # connection itself was written.
    sleep 2
    if ! ui_has_text "Connect"; then
      provisioned=1
    fi
  fi
  attempt=$((attempt + 1))
done
if [ "$provisioned" -eq 0 ]; then
  fail "verify-diagnostics: the connection was not provisioned through lectern://setup and the Connect button"
  exit 1
fi
note "verify-diagnostics: the connection was handed to the app; the hub-health row below is what proves it was written"

# 2. The checks, on the device, with the screen running them as it opens.
note "verify-diagnostics: opening lectern://diagnostics?autorun=1 (budget ${BUDGET_SECONDS}s)"
open_link "lectern://diagnostics?autorun=1" || exit 1

elapsed=0
missing=""
while [ "$elapsed" -lt "$BUDGET_SECONDS" ]; do
  rows=$(ui_nodes | awk -F'\t' '{ print $1 "\n" $2 }')
  missing=""
  for id in $CHECK_IDS; do
    if ! printf '%s\n' "$rows" | grep -qF "PASS $id"; then
      missing="$missing $id"
    fi
  done
  if [ -z "$missing" ]; then
    break
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done

# The last dump is the one the answer is read from: the rows as they stood when the loop ended.
rows=$(ui_nodes | awk -F'\t' '{ print $1 "\n" $2 }')
printf '%s\n' "$rows" | grep -F "PASS " | sed 's/^/verify-diagnostics: /' | sort -u

failed=$(printf '%s\n' "$rows" | grep -F "FAIL" || true)
if [ -n "$failed" ]; then
  fail "verify-diagnostics: FAIL text is on the screen after ${elapsed}s:"
  printf '%s\n' "$failed" | sed 's/^/  /' >&2
  exit 1
fi

missing=""
for id in $CHECK_IDS; do
  if ! printf '%s\n' "$rows" | grep -qF "PASS $id"; then
    missing="$missing $id"
  fi
done
if [ -n "$missing" ]; then
  fail "verify-diagnostics: no PASS row within ${BUDGET_SECONDS}s for:$missing"
  exit 1
fi

note "verify-diagnostics: all five checks report PASS and no FAIL text is on the screen"
