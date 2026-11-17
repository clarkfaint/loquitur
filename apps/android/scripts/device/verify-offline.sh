#!/bin/sh
# The offline check (U-053, F§10.4, F§10.1).
#
# What F§10.1 and F§10.4 promise together is that a document downloaded for offline use can be read with no hub
# reachable at all. This script takes the reader through exactly that and reads the app's own answer at every
# step:
#
#   1. the document the share-intent check created is found in the library and downloaded through the library
#      row's own control, and the row is required to reach the `complete` state;
#   2. the app is taken offline: the hub is stopped, and the `adb reverse` through which the app reaches it goes
#      with it — the connection the app holds is `http://127.0.0.1:<port>` *on the device*, so once the reverse is
#      gone and nothing answers, the app has no route to its hub at all;
#   3. the app is force-stopped and reopened, and the document is opened from the library and rewound to its
#      start — F§5.9 keeps the reader's place, and the checks this one follows read the document to near its end,
#      so a Play where the reader opens would have only a few seconds to observe; the document is then played;
#   4. the platform's media session is required to be `playing` 20 s after the tap, with the sentence the
#      session publishes having advanced: F§10.4 has the app publish the document's title and the sentence now
#      playing, so that line is the visible sentence's own report;
#   5. the hub is left stopped and the port reverse gone on every exit path, including a failure and an
#      interrupt.
#
# Why the offline half is the hub stop and not airplane mode (measured at U-053): this device is attached over
# Wi-Fi (`adb devices -l` lists a network transport and `lsusb` shows no Android device), so enabling airplane
# mode takes the only adb transport this host has down with it — measured within about three seconds as
# `error: device offline`, then `ping` 100% packet loss, then `adb connect` → `No route to host` — and a
# device-side restore scheduled before the toggle did not bring it back inside the check's budget, leaving the
# phone dark until it was toggled by hand. Stopping the hub reaches the same state (the app has no route to it)
# while the harness stays attached and can still observe, which is what makes this check repeatable. The
# contract's own words for this half are "enables hub disconnected (adb reverse removed) … and stops the hub".
#
# Nothing here changes a system setting: the app is left installed and connected, the hub process and the port
# reverse are taken down, and no file is written outside `data/device-run/` (AGENTS.md §7).
#
# Usage: sh apps/android/scripts/device/verify-offline.sh   (it starts and stops its own hub; the document and
#        the saved connection come from the run the contract's order puts before it)

. "$(dirname -- "$0")/lib.sh"

# The contract's own numbers, in seconds.
PLAY_TIMEOUT=20
OFFLINE_SECONDS=20

# How many sentences the reader's own transport may be asked to step back, and the percentage at or below which
# the reading counts as being at the document's start (the reader prints whole percent, so the last sentence of a
# document steps back to 0).
REWIND_STEPS=24
START_PERCENT=3

# How long the download may take.
DOWNLOAD_BUDGET=300

hub_started=0

# --- the screen, narrowed to one node ----------------------------------------

# The first node whose *drawn text* carries the wanted string, as a `ui_nodes` line. A row's title is text; a
# control's label is `content-desc`, and the two are asked for separately so that a document's title can never
# be confused with the offline control that sits beside it.
node_with_text() {
  ui_nodes | awk -F'\t' -v want="$1" 'index($1, want) > 0 { print; exit }'
}

# The first node whose *accessibility label* carries the wanted string. The offline control's label is
# `Download <title> for offline`, which is how this script finds the button belonging to the shared document
# rather than whichever row happens to come first in the list.
node_with_label() {
  ui_nodes | awk -F'\t' -v want="$1" 'index($2, want) > 0 { print; exit }'
}

# `wait_for_node <finder> <string> <seconds>` — poll until one of the two finders above answers. A device paints
# at its own pace and a dump is a round trip, so this is a poll rather than a sleep followed by one look.
wait_for_node() {
  finder=$1
  want=$2
  seconds=$3
  waited=0
  while [ "$waited" -lt "$seconds" ]; do
    if [ -n "$("$finder" "$want")" ]; then
      note "wait_for_node: \"$want\" is on the screen after ${waited}s"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  fail "wait_for_node: \"$want\" never appeared within ${seconds}s"
  return 1
}

# `tap_node <line>` — press the centre of the rectangle a `ui_nodes` line reports. The centre comes from the
# node's own bounds, so the tap lands wherever the device laid the control out.
tap_node() {
  line=$1
  bounds=$(printf '%s\n' "$line" | cut -f3)
  coords=$(printf '%s' "$bounds" | tr -c '0-9' ' ')
  # Word splitting is the point: the four numbers of "[x1,y1][x2,y2]" become the positional parameters.
  # shellcheck disable=SC2086
  set -- $coords
  if [ "$#" -ne 4 ]; then
    fail "tap_node: cannot read a rectangle out of \"$bounds\""
    return 1
  fi
  x=$((($1 + $3) / 2))
  y=$((($2 + $4) / 2))
  if ! "$ADB" shell input tap "$x" "$y" >/dev/null 2>&1; then
    fail "tap_node: input tap $x $y failed"
    return 1
  fi
  note "tap_node: pressed at $x,$y"
}

# `tap_found <finder> <string>` — find one node and press it.
tap_found() {
  line=$("$1" "$2") || true
  if [ -z "$line" ]; then
    fail "tap_found: no node carries \"$2\""
    return 1
  fi
  tap_node "$line"
}

# --- where the reading is -----------------------------------------------------

# `reader_percent` — the reader's own progress figure, as a number. Its player bar prints one (`<n>%`) from the
# same fraction F§5.6(f) reports, so this asks the app where the reading is rather than guessing from a tap.
reader_percent() {
  line=$(ui_nodes | awk -F'\t' '$1 ~ /%$/ { print; exit }')
  printf '%s' "$line" | cut -f1 | tr -dc '0-9'
}

# `rewind_to_start` — press the reader's own "Previous sentence" control until the bar reports the document's
# start. That control is F§10.4's skip of −1 sentence, so each press moves the reading one sentence back, and the
# condition is the bar's own figure — a reading that does not move is reported as a failure rather than waited
# out. It is bounded for that same reason: a control that answers nothing must not become an endless tap.
rewind_to_start() {
  steps=0
  while [ "$steps" -lt "$REWIND_STEPS" ]; do
    percent=$(reader_percent)
    if [ -n "$percent" ] && [ "$percent" -le "$START_PERCENT" ]; then
      note "rewind_to_start: the reading is at ${percent}%, ${steps} sentence(s) back from where it opened"
      return 0
    fi
    tap_found node_with_label "Previous sentence" || return 1
    sleep 2
    steps=$((steps + 1))
  done
  fail "rewind_to_start: the reading is still at $(reader_percent)% after ${steps} sentence(s) back"
  return 1
}

# --- the media session --------------------------------------------------------

# The sentence the session publishes: F§10.4 has the app hand the document's title and the sentence now playing
# to the lock screen, and that line is the second one the platform prints. How the platform prints it was
# measured on this device (U-052): `dumpsys media_session` writes the metadata positionally —
# `metadata: size=4, <the document's title>, <the sentence now playing>, null` — and not as `artist=…`, so the
# keyed form is read when it is there and the positional one when it is not. (The same two readers live in
# `verify-media-session.sh`; `lib.sh` carries the media *state* readers and is U-052's frozen file.)
sentence_of() {
  line=$1
  keyed=$(printf '%s' "$line" | sed -n 's/.*artist=\([^,}]*\).*/\1/p')
  if [ -n "$keyed" ]; then
    printf '%s\n' "$keyed" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
    return 0
  fi
  printf '%s' "$line" | sed 's/^[^:]*: *//' | awk -F', ' '{ print $3 }' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# --- taking the app offline, and putting it back ------------------------------

# Whatever happens from here on — a failure, an interrupt, the end of the script — the hub this script started is
# stopped, and the port reverse it is reached through goes with it. That pair *is* the offline state the check
# wants (the device's connection is loopback, so with the reverse gone there is no route to the hub), which is
# why the trap is what keeps the device offline after a failure rather than what lets the radios back.
restore() {
  if [ "$hub_started" -eq 1 ]; then
    hub_started=0
    if ! stop_hub; then
      fail "restore: stop_hub could not confirm the hub is gone"
    fi
  fi
}
trap restore EXIT INT TERM

require_device || exit 1

# 1. The document the share-intent check created, downloaded through the library row's own control.
start_hub || exit 1
hub_started=1

opened=0
attempt=1
while [ "$attempt" -le 3 ] && [ "$opened" -eq 0 ]; do
  note "verify-offline: opening the library (attempt $attempt of 3)"
  "$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1
  if [ "$attempt" -eq 1 ]; then
    # The launcher's own start: the entry route reads the saved connection and sends a configured reader to the
    # library, which is the path a reader who taps the icon takes.
    "$ADB" shell am start -n "$PACKAGE/.MainActivity" >/dev/null 2>&1 || true
  else
    open_link "lectern://library" || true
  fi
  if wait_for_node node_with_text "$SHARE_HEAD" 40; then
    opened=1
  fi
  attempt=$((attempt + 1))
done
if [ "$opened" -eq 0 ]; then
  fail "verify-offline: the library never showed the document the share-intent check created (\"$SHARE_HEAD\")"
  exit 1
fi

note "verify-offline: downloading the shared document for offline use through its row's own control"
tap_found node_with_label "Download $SHARE_HEAD" || exit 1

if ! wait_for_node node_with_text "Ready offline" "$DOWNLOAD_BUDGET"; then
  fail "verify-offline: the row never reached the complete state within ${DOWNLOAD_BUDGET}s — what is on the screen:"
  ui_nodes | awk -F'\t' '$1 != "" { print "  " $1 }' | head -20 >&2
  exit 1
fi
note "verify-offline: the document downloaded and the library row says it is ready offline"

# 2. The app goes offline: the hub is stopped, and the `adb reverse` that is its only route to it goes with it.
note "verify-offline: stopping the hub — the port reverse it is reached through goes with it"
stop_hub || exit 1
hub_started=0
note "verify-offline: nothing answers $HUB_URL and the reverse is gone, so the app has no route to its hub"

# 3. The app is force-stopped and reopened, with no hub to reach.
note "verify-offline: force-stopping $PACKAGE and reopening it with the hub stopped"
"$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1

reopened=0
attempt=1
while [ "$attempt" -le 3 ] && [ "$reopened" -eq 0 ]; do
  "$ADB" shell am start -n "$PACKAGE/.MainActivity" >/dev/null 2>&1 || true
  if wait_for_node node_with_text "$SHARE_HEAD" 40; then
    reopened=1
  fi
  attempt=$((attempt + 1))
done
if [ "$reopened" -eq 0 ]; then
  fail "verify-offline: the library never came back with the document after the app was reopened"
  exit 1
fi

note "verify-offline: opening the document in the reader"
tap_found node_with_text "$SHARE_HEAD" || exit 1

# The reading must have somewhere to go, and where the reader opens is not it: F§5.9 keeps the reader's place, the
# checks that ran before this one read this document to near its end, and the reader therefore opens near its end,
# where a Play has only a few seconds left to observe. The position this check reads from is the document's start
# — which is also where a reader who has just prepared a document for offline use is, having never heard it — so
# the reading is stepped back there with the reader's own transport, off the hub that is now stopped.
note "verify-offline: rewinding the reading to the document's start (F§5.9 keeps the reader's place)"
rewind_to_start || exit 1

wait_for_tappable "Play" 90 || {
  fail "verify-offline: the reader's play control never became pressable with the hub stopped"
  exit 1
}
tap_text "Play" || exit 1

# 4. The reading is `playing`, and stays playing, with nothing to reach.
state=$(wait_for_media_state playing "$PLAY_TIMEOUT") || {
  fail "verify-offline: the session is $state ${PLAY_TIMEOUT}s after the tap, with the hub stopped and no route to it"
  media_metadata >&2 || true
  exit 1
}
note "verify-offline: $state within ${PLAY_TIMEOUT}s of the tap, with the hub stopped and no route to it"

sentence_before=$(sentence_of "$(media_metadata)")
sleep "$OFFLINE_SECONDS"
state=$(media_state) || exit 1
if [ "$state" != "playing" ]; then
  fail "verify-offline: the session is $state ${OFFLINE_SECONDS}s after it started playing offline"
  media_metadata >&2 || true
  exit 1
fi
note "verify-offline: still $state ${OFFLINE_SECONDS}s later, with no hub running and no route to it"

sentence_after=$(sentence_of "$(media_metadata)")
if [ -z "$sentence_before" ] || [ -z "$sentence_after" ]; then
  fail "verify-offline: the session published no sentence (before: \"$sentence_before\", after: \"$sentence_after\")"
  media_metadata >&2 || true
  exit 1
fi
if [ "$sentence_after" = "$sentence_before" ]; then
  fail "verify-offline: the sentence did not advance while offline — \"$sentence_before\" both times"
  exit 1
fi
note "verify-offline: the sentence advanced while offline — \"$sentence_before\" → \"$sentence_after\""

# 5. The device is left as it was: no hub running and no port reverse (the trap does the same on every other
# path, including a failure).
note "verify-offline: the hub is stopped and the port reverse is gone"

note "verify-offline: the document was prepared offline, and it played for ${OFFLINE_SECONDS}s with no hub running, no route to it and the sentence advancing"
