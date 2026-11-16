#!/bin/sh
# The share-intent check (U-052, F§10.4).
#
# Another app shares plain text with Lectern: the platform's own `SEND` action with `text/plain`, addressed to
# this app's package. What the run proves is the whole path F§10.4 describes — the intent reaches the app,
# `expo-sharing`'s plugin-declared filter accepts it, the module rewrites the launch at `lectern://expo-sharing`,
# `app/+native-intent.ts` turns that into `/handle-share`, the handler plans and imports the text on the device
# (F§5.4's local path — no hub is needed to build a document from text), and the reader opens on it.
#
# The check is the contract's own: the reader is open and its first words are visible. The app is force-stopped
# first, so the share arrives at a cold start the way a share from another app does rather than into a screen
# this harness left open.
#
# Usage: sh apps/android/scripts/device/verify-share-intent.sh   (a hub must be running; run-all.sh starts one)

. "$(dirname -- "$0")/lib.sh"

require_device || exit 1

note "verify-share-intent: stopping $PACKAGE, then sharing ${#SHARE_TEXT} characters of text with it"
"$ADB" shell am force-stop "$PACKAGE" >/dev/null 2>&1
send_share_intent "$SHARE_TEXT" || exit 1

if ! wait_for_text "$SHARE_HEAD" 120; then
  fail "verify-share-intent: the reader never showed \"$SHARE_HEAD\" — what is on the screen instead:"
  ui_nodes | awk -F'\t' '$1 != "" { print "  " $1 }' | head -20 >&2
  exit 1
fi

foreground=$(foreground_package)
case "$foreground" in
  "$PACKAGE")
    note "verify-share-intent: $PACKAGE holds the focused window, showing the shared text"
    ;;
  *)
    fail "verify-share-intent: the shared text is on screen but the focused window belongs to \"$foreground\""
    exit 1
    ;;
esac

note "verify-share-intent: the reader opened on the shared text and its first words are visible"
