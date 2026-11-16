#!/bin/sh
# The whole device verification, in the contract's order (U-052, F§10.4).
#
# One release APK is built and installed, one mock-engine hub is started with the port reverse that lets the
# device reach it, and the three verify scripts run in the order the contract names: the on-device conformance
# run (which also provisions the connection), the share-intent check, and the media-session check.
#
# The hub and the port reverse are taken down whatever happened — including when a verify script fails, and
# including when this script is interrupted — because the contract forbids leaving the hub process, the port
# forwards or the device's network state changed after the scripts exit. Nothing else about the device is
# touched, and the app is left installed and connected, which is where a reader would want it.
#
# Exits 0 only when every script passed.
#
# Usage: sh apps/android/scripts/device/run-all.sh

. "$(dirname -- "$0")/lib.sh"

overall=0
hub_started=0

note "run-all: harness in $DEVICE_DIR, repository $REPO_ROOT"

# Whatever happens from here on, the hub and the reverse go away. The flag is what keeps a second stop_hub from
# running after the ordinary one below.
cleanup() {
  if [ "$hub_started" = "1" ]; then
    hub_started=0
    if ! stop_hub; then
      fail "run-all: stop_hub could not confirm the hub is gone"
    fi
  fi
}
trap cleanup EXIT INT TERM

require_device || exit 1
build_release_apk || exit 1
install_apk || exit 1
start_hub || exit 1
hub_started=1

for script in verify-diagnostics.sh verify-share-intent.sh verify-media-session.sh; do
  note "run-all: sh $DEVICE_DIR/$script"
  if sh "$DEVICE_DIR/$script"; then
    note "run-all: $script passed"
  else
    overall=1
    fail "run-all: $script failed"
  fi
done

cleanup

if [ "$overall" -eq 0 ]; then
  note "run-all: every check passed"
else
  fail "run-all: at least one check failed"
fi
exit "$overall"
