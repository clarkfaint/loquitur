#!/bin/sh
# The media-session check (U-052, F§10.4).
#
# What F§10.4 promises on Android is that a reading survives the reader leaving the app, that the platform's own
# transport drives it, and that the lock screen says what is being read. This script takes the reader through
# exactly those states and reads the platform's answer at each one, through `dumpsys media_session` and
# `cmd media_session dispatch` and nothing else:
#
#   1. the reader is opened on the shared document and play is pressed on the reader's own transport;
#   2. `playing` within 20 s of the tap;
#   3. the Home key, then `playing` 30 s later — the app is off screen and the reading is not;
#   4. `media_dispatch pause` → `paused`, `media_dispatch play` → `playing`, `media_dispatch next` → `playing`:
#      the lock screen's own transport, driven the way the platform drives it;
#   5. the Sleep key, then `playing` 20 s later — the screen is off and the reading is not;
#   6. the device is woken and the sentence the session publishes must have advanced, which is the lock screen's
#      own second line: F§10.4 has the app publish the document's title and the sentence now playing, and that
#      line is what a reader sees while the screen is off.
#
# Nothing here changes a system setting: the lock screen, battery optimisation and every protection stay as the
# operator left them, and no system protection is disabled to make a check pass (the contract's Forbidden
# Actions). The two key events are the ones the reader's own thumb produces.
#
# The reader is opened by this script rather than assumed from an earlier one, because a check that only passes
# when its predecessor ran is not a check.
#
# Usage: sh apps/android/scripts/device/verify-media-session.sh   (a hub must be running; run-all.sh starts one)

. "$(dirname -- "$0")/lib.sh"

# The contract's three numbers, in seconds.
PLAY_TIMEOUT=20
BACKGROUND_SECONDS=30
SCREEN_OFF_SECONDS=20

# The sentence the session publishes — F§10.4 has the app hand the document's title and the sentence now playing
# to the lock screen, and this is the line a reader sees while the screen is off.
#
# How the platform prints it was measured on this device: `dumpsys media_session` writes the metadata
# positionally — `metadata: size=4, <the document's title>, <the sentence now playing>, null` — and not as
# `artist=…`, so the keyed form is read when it is there and the positional one is read when it is not. An empty
# answer is reported as such rather than compared.
sentence_of() {
  line=$1
  keyed=$(printf '%s' "$line" | sed -n 's/.*artist=\([^,}]*\).*/\1/p')
  if [ -n "$keyed" ]; then
    printf '%s\n' "$keyed" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
    return 0
  fi
  printf '%s' "$line" | sed 's/^[^:]*: *//' | awk -F', ' '{ print $3 }' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

require_device || exit 1

# 1. The shared document, open in the reader.
note "verify-media-session: opening the reader on the shared document"
"$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1
send_share_intent "$SHARE_TEXT" || exit 1
wait_for_text "$SHARE_HEAD" 120 || {
  fail "verify-media-session: the reader never opened on the shared document"
  exit 1
}

# 2. Play, from the reader's own transport. The control is disabled while the player is idle or loading, so the
# wait is for an enabled node rather than for the label to exist.
note "verify-media-session: pressing play on the reader's transport"
wait_for_tappable "Play" 90 || {
  fail "verify-media-session: the reader's play control never became pressable"
  exit 1
}
tap_text "Play" || exit 1

state=$(wait_for_media_state playing "$PLAY_TIMEOUT") || {
  fail "verify-media-session: the session is $state ${PLAY_TIMEOUT}s after the tap, not playing"
  media_metadata >&2 || true
  exit 1
}
note "verify-media-session: $state within ${PLAY_TIMEOUT}s of the tap"

# 3. The app leaves the screen; the reading does not stop.
note "verify-media-session: pressing Home, then reading the session ${BACKGROUND_SECONDS}s later"
"$ADB" shell input keyevent 3 >/dev/null 2>&1
sleep "$BACKGROUND_SECONDS"
state=$(media_state) || exit 1
if [ "$state" != "playing" ]; then
  fail "verify-media-session: the session is $state ${BACKGROUND_SECONDS}s after the app left the screen"
  media_metadata >&2 || true
  exit 1
fi
note "verify-media-session: still $state ${BACKGROUND_SECONDS}s after the app left the screen"

# 4. The lock screen's own transport, one command at a time.
media_dispatch pause || exit 1
state=$(wait_for_media_state paused 15) || {
  fail "verify-media-session: pause left the session $state"
  exit 1
}
note "verify-media-session: pause → $state"

media_dispatch play || exit 1
state=$(wait_for_media_state playing "$PLAY_TIMEOUT") || {
  fail "verify-media-session: play left the session $state"
  exit 1
}
note "verify-media-session: play → $state"

sentence_before=$(sentence_of "$(media_metadata)")
media_dispatch next || exit 1
state=$(wait_for_media_state playing "$PLAY_TIMEOUT") || {
  fail "verify-media-session: next left the session $state"
  exit 1
}
note "verify-media-session: next → $state"

# 5. The screen goes off; the reading does not stop.
sentence_off=$(sentence_of "$(media_metadata)")
note "verify-media-session: pressing Sleep, then reading the session ${SCREEN_OFF_SECONDS}s later"
"$ADB" shell input keyevent 223 >/dev/null 2>&1
sleep "$SCREEN_OFF_SECONDS"
state=$(media_state) || exit 1
if [ "$state" != "playing" ]; then
  fail "verify-media-session: the session is $state ${SCREEN_OFF_SECONDS}s after the screen went off"
  media_metadata >&2 || true
  exit 1
fi
note "verify-media-session: still $state ${SCREEN_OFF_SECONDS}s after the screen went off"

# 6. Wake, and the sentence the lock screen shows must have moved on.
"$ADB" shell input keyevent 224 >/dev/null 2>&1
sleep 5
sentence_after=$(sentence_of "$(media_metadata)")
if [ -z "$sentence_off" ] || [ -z "$sentence_after" ]; then
  fail "verify-media-session: the session published no sentence (before the screen went off: \"$sentence_off\", after waking: \"$sentence_after\")"
  media_metadata >&2 || true
  exit 1
fi
if [ "$sentence_after" = "$sentence_off" ]; then
  fail "verify-media-session: the sentence did not advance — \"$sentence_off\" before the screen went off and \"$sentence_after\" after waking"
  exit 1
fi
note "verify-media-session: the sentence advanced while the screen was off — \"$sentence_off\" → \"$sentence_after\""

note "verify-media-session: playback, the lock screen's transport, background and screen-off playback all hold"
