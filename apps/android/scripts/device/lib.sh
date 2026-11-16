#!/bin/sh
# U-052's device harness — the functions the four `apps/android/scripts/device/*.sh` scripts share.
#
# The harness drives the operator's own device through `adb` and `uiautomator dump` and nothing else: no
# UI-automation framework is used, installed or referenced, because the contract forbids one and because the
# accessibility tree already answers the two questions these checks ask — which strings are on screen, and
# where they are. The hub the checks read with is this repository's own `@lectern/server`, started with F§7.1's
# mock engine on `127.0.0.1:8787` and reached from the device through `adb reverse tcp:8787 tcp:8787`.
#
# Everything a run writes — the hub's data directory, its log, its PID file — lives under
# `<repo>/data/device-run/`, which `.gitignore` already excludes as runtime data, so a run leaves no untracked
# path behind for `scripts/check-scope.mjs` to see, and nothing outside the repository is written or deleted
# (AGENTS.md §7).
#
# All four scripts live in this one directory, so `$0` — which POSIX `sh` leaves pointing at the calling script
# inside a sourced file — locates the repository from any of them.
#
# Usage: `. "$(dirname "$0")/lib.sh"` from a script in this directory.

# --- paths and settings -------------------------------------------------------

DEVICE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$DEVICE_DIR/../../../.." && pwd)

ANDROID_APP_DIR="$REPO_ROOT/apps/android"
ANDROID_PROJECT_DIR="$ANDROID_APP_DIR/android"
SERVER_DIR="$REPO_ROOT/apps/server"
RUN_DIR="$REPO_ROOT/data/device-run"
HUB_DATA_DIR="$RUN_DIR/hub"
HUB_LOG="$RUN_DIR/hub.log"
HUB_PID_FILE="$RUN_DIR/hub.pid"

# The window dump is written to a file on the device rather than to the console, because `uiautomator` prints
# its own progress line to the same stream the XML would arrive on.
UI_DUMP_REMOTE="/sdcard/lectern-device-ui.xml"

# F§7.1's default port. F§7.1's floor for the token is 32 characters, and this is the token the repository's own
# hub tests use (`apps/server/src/__tests__/engine-routes.test.ts`): it is not a credential, it authenticates a
# mock-engine hub this harness starts on the loopback interface and stops again, and both values are
# overridable so a second run does not collide with a first.
HUB_PORT="${LECTERN_DEVICE_HUB_PORT:-8787}"
HUB_TOKEN="${LECTERN_DEVICE_HUB_TOKEN:-lectern-hub-test-token-0123456789}"
HUB_URL="http://127.0.0.1:$HUB_PORT"

# F§10.4's package id: the application every check reads.
PACKAGE="dev.lectern.app"

# What `build_release_apk` produces and `install_apk` installs.
APK_PATH="$ANDROID_PROJECT_DIR/app/build/outputs/apk/release/app-release.apk"

# The Android SDK the gradle build finds its platform and build-tools in. `expo prebuild` writes no
# `android/local.properties`, so the build reads this variable — the same one `scripts/preflight.mjs --phase 4`
# checks — and the default is the directory this host's operator uses.
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_HOME

# `adb` from the SDK when the operator has one, otherwise whatever PATH holds. `ANDROID_SERIAL`, when it is
# exported, is what selects one device out of several; `adb` itself reads it.
if [ -z "${ADB:-}" ]; then
  if [ -x "$ANDROID_HOME/platform-tools/adb" ]; then
    ADB="$ANDROID_HOME/platform-tools/adb"
  else
    ADB=adb
  fi
fi

# The text `verify-share-intent.sh` shares into the app and `verify-media-session.sh` opens the reader with:
# twelve sentences of Lectern's own wording (AGENTS.md §4.6 — a fixture is text this repository writes), long
# enough that the reader holds several sentences to advance through while the screen is off. It carries no
# apostrophe, comma or shell metacharacter, because it travels through `am start --es` into the device's own
# shell and is compared against the session's published metadata.
SHARE_TEXT="Lectern reads a document aloud. It keeps the place of the reader in the text. The active sentence is highlighted as it is spoken. The active word is highlighted more strongly. Playback continues while the screen is off. The transport moves one sentence at a time. A tap on a sentence seeks to that sentence. Speed and voice can be changed while reading. The library holds every imported document. The share sheet sends text straight to the reader. The hub synthesizes audio from the sentences of the document. This text exists to verify the device flow."

# The opening words of that text: what the reader must be showing once the share has been imported.
SHARE_HEAD="Lectern reads a document aloud"

# --- reporting ----------------------------------------------------------------

# One line of progress on stdout. Every message names the function that produced it, so a failure inside a long
# run can be attributed to the step it came from.
note() {
  printf '%s\n' "$*"
}

# One line of failure on stderr, so a caller can read a function's answer from stdout while the reason a
# function refused travels separately.
fail() {
  printf '%s\n' "$*" >&2
}

# --- the device ---------------------------------------------------------------

# `require_device` — there is a device to talk to, and it answers. Fails when `adb` is missing, when no device
# is attached, and when the transport is attached but not usable (`offline`, `unauthorized`, `no permissions`),
# and says which of those it found.
require_device() {
  if ! command -v "$ADB" >/dev/null 2>&1; then
    fail "require_device: $ADB is not on PATH — export ANDROID_HOME or put platform-tools on PATH"
    return 1
  fi
  state=$("$ADB" get-state 2>&1 | tr -d '\r')
  if [ "$state" != "device" ]; then
    fail "require_device: adb get-state answered \"$state\", not \"device\" — attach a device or an emulator, and export ANDROID_SERIAL when several are attached"
    return 1
  fi
  serial=$("$ADB" get-serialno 2>/dev/null | tr -d '\r')
  model=$("$ADB" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
  release=$("$ADB" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
  abi=$("$ADB" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')
  if [ -z "$model" ]; then
    fail "require_device: $serial answers get-state but not getprop — its shell is not usable"
    return 1
  fi
  note "require_device: $serial — $model, Android $release, $abi"
}

# `send_share_intent <text>` — hand a text share to the app the way another app's share sheet does: the
# platform's own `SEND` action with F§10.4's `text/plain`, addressed to this app's package so no chooser
# intervenes. The text is single-quoted for the *device's* shell, which is what `adb shell` runs the command
# in — an unquoted `&` or `;` inside a share would otherwise end the command there.
send_share_intent() {
  text=$1
  answer=$("$ADB" shell am start -a android.intent.action.SEND -t text/plain -p "$PACKAGE" \
    --es android.intent.extra.TEXT "'$text'" 2>&1 | tr -d '\r')
  case "$answer" in
    *Error*|*error*|*"does not exist"*)
      fail "send_share_intent: am start refused the share — $answer"
      return 1
      ;;
  esac
  note "send_share_intent: SEND text/plain handed to $PACKAGE (${#text} characters)"
}

# `open_link <url>` — open one of the app's own addresses, the way a reader would arrive from a chat message or
# a terminal. The address is single-quoted for the device's shell for the same reason a share is: it carries
# `?`, `&` and `=`.
open_link() {
  url=$1
  if [ -z "$url" ]; then
    fail "open_link: no address was given"
    return 1
  fi
  answer=$("$ADB" shell am start -a android.intent.action.VIEW -d "'$url'" 2>&1 | tr -d '\r')
  case "$answer" in
    *Error*|*error*|*"does not exist"*)
      fail "open_link: am start refused \"$url\" — $answer"
      return 1
      ;;
  esac
  note "open_link: opened $url"
}

# The package holding the focused window, or an empty string when nothing is focused. This is how a check says
# that what it is reading is the app in front of the reader rather than a notification or another app.
foreground_package() {
  focus=$(timeout 60 "$ADB" shell dumpsys window 2>/dev/null | tr -d '\r' | grep -m1 "mCurrentFocus")
  printf '%s\n' "$focus" | sed -n 's/.*u0 \([^/]*\)\/.*/\1/p'
}

# --- the screen ---------------------------------------------------------------

# `ui_dump` — the current window's accessibility tree as XML. `uiautomator` refuses to dump while the screen is
# off, while the window is not idle or while another dump is in flight, so it is retried; the XML is read back
# only when it really carries a hierarchy, because `uiautomator` can exit 0 with nothing but a complaint.
ui_dump() {
  attempt=1
  while [ "$attempt" -le 4 ]; do
    if timeout 60 "$ADB" shell uiautomator dump "$UI_DUMP_REMOTE" >/dev/null 2>&1; then
      xml=$(timeout 60 "$ADB" shell cat "$UI_DUMP_REMOTE" 2>/dev/null | tr -d '\r')
      case "$xml" in
        *"<hierarchy"*)
          printf '%s\n' "$xml"
          return 0
          ;;
      esac
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  fail "ui_dump: uiautomator produced no readable hierarchy in 4 attempts"
  return 1
}

# One line per node, as `text<TAB>content-desc<TAB>bounds<TAB>enabled`. React Native puts a control's own label
# in `content-desc` (its `accessibilityLabel`) and its drawn string in `text`, so both are kept; `enabled` is
# what distinguishes a control that is merely drawn from one that can be pressed.
#
# The tree is split at every `<node`, not at every `/>`: `uiautomator` writes a container as `<node …>` with its
# children after it, so splitting on `/>` would leave a container and its first child on one line and the child's
# own text would be lost to the container's empty `text=""`. Splitting at the tag keeps each node's attributes on
# the line that starts with it.
ui_nodes() {
  ui_dump | sed 's|<node|\n<node|g' | awk '
    {
      text = ""; desc = ""; bounds = ""; enabled = "";
      if (match($0, /text="[^"]*"/)) text = substr($0, RSTART + 6, RLENGTH - 7);
      if (match($0, /content-desc="[^"]*"/)) desc = substr($0, RSTART + 14, RLENGTH - 15);
      if (match($0, /enabled="[^"]*"/)) enabled = substr($0, RSTART + 9, RLENGTH - 10);
      if (match($0, /bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"/)) bounds = substr($0, RSTART + 8, RLENGTH - 9);
      if (bounds != "") printf "%s\t%s\t%s\t%s\n", text, desc, bounds, enabled;
    }'
}

# The nodes whose `text` or `content-desc` matches the wanted string, as `ui_nodes` lines. `exact` matches the
# whole string, anything else matches a part of it — a React Native text node carries a whole paragraph, so the
# two modes are both needed and the caller chooses.
ui_find() {
  want=$1
  mode=$2
  ui_nodes | awk -F'\t' -v want="$want" -v mode="$mode" '
    {
      hit = 0;
      if (mode == "exact") { if ($1 == want || $2 == want) hit = 1 }
      else { if (index($1, want) > 0 || index($2, want) > 0) hit = 1 }
      if (hit == 1) print;
    }'
}

# A node matching the wanted string, preferring an exact match: a screen holds both a "Connect" button and a
# "Connect to a hub" heading, and tapping the heading would report a success that never happened. Returns 1 when
# nothing matches at all.
ui_match() {
  want=$1
  exact=$(ui_find "$want" exact)
  if [ -n "$exact" ]; then
    printf '%s\n' "$exact"
    return 0
  fi
  found=$(ui_find "$want" contains)
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

# `ui_has_text <text>` — the string is on the screen, as a node's whole text, a node's label, or a part of
# either. Containment is the mode the checks need: the reader shows a whole block of text, and the contract asks
# whether the sentence it is reading is visible rather than whether the screen holds that string alone.
ui_has_text() {
  ui_match "$1" >/dev/null
}

# `wait_for_text <text> <seconds>` — poll the screen until the string is on it. A device paints at its own pace
# and a dump is a round trip, so this is a poll rather than a sleep followed by one look.
wait_for_text() {
  want=$1
  seconds=$2
  waited=0
  while [ "$waited" -lt "$seconds" ]; do
    if ui_has_text "$want"; then
      note "wait_for_text: \"$want\" is on the screen after ${waited}s"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  fail "wait_for_text: \"$want\" never appeared within ${seconds}s"
  return 1
}

# `wait_for_tappable <text> <seconds>` — poll until a node matching the string is enabled. The reader's transport
# is disabled while the player is `idle` or `loading` (F§5.7's two states), so a tap that arrives too early is
# swallowed by a control that cannot act: waiting for `enabled="true"` is what makes the tap meaningful.
wait_for_tappable() {
  want=$1
  seconds=$2
  waited=0
  while [ "$waited" -lt "$seconds" ]; do
    node=$(ui_match "$want" | awk -F'\t' '$4 == "true" { print; exit }')
    if [ -n "$node" ]; then
      note "wait_for_tappable: \"$want\" is enabled after ${waited}s"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  fail "wait_for_tappable: \"$want\" never became enabled within ${seconds}s"
  return 1
}

# `tap_text <text>` — press the node carrying the string, at the centre of the rectangle it reports. The centre
# is computed from the node's own bounds, so the tap lands wherever the device laid the control out rather than
# at a coordinate this harness guessed.
tap_text() {
  want=$1
  matches=$(ui_match "$want") || {
    fail "tap_text: no node carries \"$want\""
    return 1
  }
  bounds=$(printf '%s\n' "$matches" | head -1 | cut -f3)
  coords=$(printf '%s' "$bounds" | tr -c '0-9' ' ')
  # Word splitting is the point here: the four numbers of "[x1,y1][x2,y2]" become the positional parameters.
  # shellcheck disable=SC2086
  set -- $coords
  if [ "$#" -ne 4 ]; then
    fail "tap_text: cannot read a rectangle out of \"$bounds\""
    return 1
  fi
  x=$((($1 + $3) / 2))
  y=$((($2 + $4) / 2))
  if ! "$ADB" shell input tap "$x" "$y" >/dev/null 2>&1; then
    fail "tap_text: input tap $x $y failed"
    return 1
  fi
  note "tap_text: pressed \"$want\" at $x,$y"
}

# --- the media session --------------------------------------------------------

# The block `dumpsys media_session` prints for this app's session, or an empty string when the platform holds no
# session for it. `package=` comes before the block's state and metadata lines, and a header line — two spaces
# and a name — starts the next block, which is what closes this one.
media_session_block() {
  dump=$(timeout 60 "$ADB" shell dumpsys media_session 2>/dev/null | tr -d '\r')
  if [ -z "$dump" ]; then
    fail "media_session_block: dumpsys media_session produced nothing"
    return 1
  fi
  printf '%s\n' "$dump" | awk -v pkg="$PACKAGE" '
    index($0, "package=" pkg) > 0 { mine = 1; next }
    /^  [A-Za-z]/ { mine = 0 }
    mine == 1 { print }
  '
}

# `media_state` — what the platform's media session for this app is doing, as one of the three words the
# contract names: `playing`, `paused` or `none`.
#
# `dumpsys media_session` prints the playback state either numerically
# (`state=PlaybackState {state=3, position=…}`) or by name (`state=PLAYING(3)`), so both forms are read. The same
# line also carries `error state=0`, which is why the numeric state comes from the braced form and the named one
# from a word of three or more capitals, rather than from the last `state=` on the line.
#
# The transient states a queue produces while it moves between chunks — `BUFFERING`, `SKIPPING_TO_NEXT`,
# `SKIPPING_TO_PREVIOUS`, `FAST_FORWARDING`, `REWINDING` — read as `playing`: a session in one of them has been
# told to play and is advancing, and a reader who pressed play and was told `none` because the next chunk was
# still being prepared would be reading a false negative.
media_state() {
  block=$(media_session_block) || return 1
  if [ -z "$block" ]; then
    printf 'none\n'
    return 0
  fi
  line=$(printf '%s\n' "$block" | grep -m1 "state=")
  named=$(printf '%s' "$line" | grep -o 'state=[A-Z_]\{3,\}' | head -1 | cut -d= -f2)
  numeric=$(printf '%s' "$line" | grep -o '{state=[0-9]\{1,\}' | head -1 | cut -d= -f2)
  state=${named:-$numeric}
  case "$state" in
    PLAYING | 3 | 4 | 5 | 6 | 9 | 10 | 11) printf 'playing\n' ;;
    PAUSED | 2) printf 'paused\n' ;;
    *) printf 'none\n' ;;
  esac
}

# `wait_for_media_state <playing|paused> <seconds>` — poll `media_state` until it answers the wanted word, and
# print the last answer either way. The session is polled rather than sampled once because the platform
# publishes a state after the queue has prepared what the tap asked for, not at the instant of the tap.
wait_for_media_state() {
  want=$1
  seconds=$2
  waited=0
  answer=none
  while [ "$waited" -lt "$seconds" ]; do
    answer=$(media_state) || return 1
    if [ "$answer" = "$want" ]; then
      printf '%s\n' "$answer"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  printf '%s\n' "$answer"
  return 1
}

# The metadata line of this app's session, which is what the platform's lock screen and its media notification
# draw their two lines from: F§10.4 has the app publish the document's title and the sentence now playing.
# Empty when the session carries no metadata.
media_metadata() {
  block=$(media_session_block) || return 1
  printf '%s\n' "$block" | grep -m1 "metadata:"
}

# `media_dispatch <play|pause|next|previous>` — send one transport command to the platform's media session, the
# way the lock screen's own buttons do. `cmd media_session dispatch` is the modern form and is tried first; the
# older `media dispatch` is the fallback for platforms that carry it instead.
media_dispatch() {
  key=$1
  case "$key" in
    play | pause | next | previous) ;;
    *)
      fail "media_dispatch: expected play, pause, next or previous, received \"$key\""
      return 1
      ;;
  esac
  if "$ADB" shell cmd media_session dispatch "$key" >/dev/null 2>&1; then
    note "media_dispatch: cmd media_session dispatch $key"
    return 0
  fi
  if "$ADB" shell media dispatch "$key" >/dev/null 2>&1; then
    note "media_dispatch: media dispatch $key (the fallback form)"
    return 0
  fi
  fail "media_dispatch: neither \"cmd media_session dispatch $key\" nor \"media dispatch $key\" is available on this device"
  return 1
}

# --- the hub ------------------------------------------------------------------

# `start_hub` — this repository's own hub with F§7.1's mock engine on the loopback interface, and the port
# reverse that lets the device reach it. Refuses to start a second hub over a first, and reports the hub's own
# log when it will not come up, because a hub that dies on a bad configuration is the one failure this step
# cannot diagnose from silence.
start_hub() {
  mkdir -p "$RUN_DIR" "$HUB_DATA_DIR" || {
    fail "start_hub: cannot create $RUN_DIR"
    return 1
  }
  if [ -f "$HUB_PID_FILE" ] && kill -0 "$(cat "$HUB_PID_FILE")" 2>/dev/null; then
    fail "start_hub: a hub is already running (pid $(cat "$HUB_PID_FILE")) — call stop_hub first"
    return 1
  fi
  if curl -fsS --max-time 2 "$HUB_URL/healthz" >/dev/null 2>&1; then
    fail "start_hub: something already answers $HUB_URL/healthz — stop it, or set LECTERN_DEVICE_HUB_PORT"
    return 1
  fi
  tsx="$SERVER_DIR/node_modules/.bin/tsx"
  if [ ! -x "$tsx" ]; then
    fail "start_hub: $tsx is missing — the workspace is not installed"
    return 1
  fi
  (
    cd "$SERVER_DIR" || exit 1
    exec env LECTERN_TOKEN="$HUB_TOKEN" LECTERN_ENABLE_MOCK=1 LECTERN_PORT="$HUB_PORT" \
      LECTERN_DATA_DIR="$HUB_DATA_DIR" "$tsx" src/main.ts
  ) >"$HUB_LOG" 2>&1 &
  echo $! >"$HUB_PID_FILE"
  waited=0
  while [ "$waited" -lt 60 ]; do
    if curl -fsS --max-time 2 "$HUB_URL/healthz" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$(cat "$HUB_PID_FILE")" 2>/dev/null; then
      fail "start_hub: the hub exited before it answered — its log says:"
      tail -20 "$HUB_LOG" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! curl -fsS --max-time 2 "$HUB_URL/healthz" >/dev/null 2>&1; then
    fail "start_hub: the hub did not answer $HUB_URL/healthz within 60s — its log says:"
    tail -20 "$HUB_LOG" >&2
    return 1
  fi
  if ! "$ADB" reverse "tcp:$HUB_PORT" "tcp:$HUB_PORT" >/dev/null 2>&1; then
    fail "start_hub: adb reverse tcp:$HUB_PORT failed"
    return 1
  fi
  if ! "$ADB" reverse --list 2>/dev/null | grep -q "tcp:$HUB_PORT"; then
    fail "start_hub: the reverse for tcp:$HUB_PORT is not in adb reverse --list"
    return 1
  fi
  note "start_hub: mock-engine hub on $HUB_URL (pid $(cat "$HUB_PID_FILE")), device reverse tcp:$HUB_PORT in place"
}

# `stop_hub` — the hub and the port reverse go away, and the port really is free before this returns. The hub is
# `tsx`, which runs the server in a child process, so the children are signalled first; the process group is not
# used because this harness must not depend on `setsid` to leave the operator's device and host as it found them
# (the contract's Forbidden Actions).
stop_hub() {
  if [ -f "$HUB_PID_FILE" ]; then
    pid=$(cat "$HUB_PID_FILE")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill "$child" 2>/dev/null || true
      done
      kill "$pid" 2>/dev/null || true
      waited=0
      while [ "$waited" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
        sleep 1
      fi
      note "stop_hub: stopped the hub process $pid"
    fi
    rm -f "$HUB_PID_FILE"
  fi
  "$ADB" reverse --remove "tcp:$HUB_PORT" >/dev/null 2>&1 || true
  waited=0
  while [ "$waited" -lt 10 ]; do
    if ! curl -fsS --max-time 1 "$HUB_URL/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if curl -fsS --max-time 1 "$HUB_URL/healthz" >/dev/null 2>&1; then
    fail "stop_hub: $HUB_URL still answers — a hub process is still running"
    return 1
  fi
  if "$ADB" reverse --list 2>/dev/null | grep -q "tcp:$HUB_PORT"; then
    fail "stop_hub: the reverse for tcp:$HUB_PORT is still in adb reverse --list"
    return 1
  fi
  note "stop_hub: nothing answers $HUB_URL, and the port reverse is gone"
}

# --- building and installing --------------------------------------------------

# `build_release_apk` — the two commands the contract names: prebuild the native project, then build the release
# variant. `--clean` matters: the project the APK is built from is the one generated from the committed `app.json`
# and the committed source, not a directory left behind by an earlier run.
build_release_apk() {
  if [ ! -d "$ANDROID_APP_DIR" ]; then
    fail "build_release_apk: $ANDROID_APP_DIR does not exist"
    return 1
  fi
  note "build_release_apk: expo prebuild --platform android --clean --no-install (ANDROID_HOME=$ANDROID_HOME)"
  (
    cd "$ANDROID_APP_DIR" || exit 1
    npx expo prebuild --platform android --clean --no-install
  ) || {
    fail "build_release_apk: expo prebuild exited non-zero"
    return 1
  }
  note "build_release_apk: ./gradlew :app:assembleRelease"
  (
    cd "$ANDROID_PROJECT_DIR" || exit 1
    ./gradlew :app:assembleRelease --console=plain
  ) || {
    fail "build_release_apk: gradle exited non-zero"
    return 1
  }
  if [ ! -f "$APK_PATH" ]; then
    fail "build_release_apk: gradle finished but $APK_PATH does not exist"
    return 1
  fi
  note "build_release_apk: $(wc -c <"$APK_PATH" | tr -d ' ') bytes at $APK_PATH"
}

# `install_apk` — the APK the build just produced, installed over whatever is on the device. `adb install`
# answers `Success` on stdout and the reason on stderr, so both are read.
install_apk() {
  if [ ! -f "$APK_PATH" ]; then
    fail "install_apk: $APK_PATH does not exist — build_release_apk has not run"
    return 1
  fi
  answer=$("$ADB" install -r "$APK_PATH" 2>&1 | tr -d '\r' | grep -v '^$' | tail -1)
  case "$answer" in
    Success*)
      note "install_apk: $answer"
      ;;
    *)
      fail "install_apk: adb install answered \"$answer\""
      return 1
      ;;
  esac
}
