#!/usr/bin/env bash
# Build the ShareCut iOS app for the Simulator, install it and launch it.
#
#   scripts/ios/ios_sim.sh run       build, install, launch (what `make ios-sim` runs)
#   scripts/ios/ios_sim.sh build     build only; prints the .app path
#   scripts/ios/ios_sim.sh launch    install and launch the last build
#   scripts/ios/ios_sim.sh proof     assert what the app promises (make ios-sim-proof)
#
# IOS_SIM_DEVICE names the simulator (name or UDID; default: the booted one). IOS_SIM_UI_WINDOW=<seconds>
# keeps the app open during the proof for a person to open a project (assertion 5). Signing is never
# involved: the Simulator build takes a placeholder team from the environment, and the real team
# stays outside the repository.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$ROOT/gui/desktop"
TAURI="$DESKTOP/src-tauri"
DEVICE="${IOS_SIM_DEVICE:-booted}"
LOG_DIR="${IOS_SIM_LOG_DIR:-$ROOT/gui/desktop/src-tauri/target/ios-sim-logs}"

# Homebrew's rustc has no iOS standard library; the rustup toolchain must come first.
if command -v rustup >/dev/null 2>&1; then
  export PATH="$(dirname "$(rustup which rustc)"):$PATH"
fi
# The Python.xcframework install phase calls rsync; Homebrew's rsync 3.5.1 hangs on it, Apple's does not.
export PATH="/usr/bin:$PATH"
export APPLE_DEVELOPMENT_TEAM="${APPLE_DEVELOPMENT_TEAM:-AAAAAAAAAA}"

bundle_identifier() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundle_identifier"])' \
    "${PODCAST_DISTRIBUTION_PROFILE:-$ROOT/config/distribution.dev.json}"
}

build() {
  # The payload ships whatever gui/web/dist holds and does not rebuild it, so a stale build would
  # run the previous web UI. Rebuild it every time (gui/web/dist is not tracked).
  (cd "$ROOT/gui/web" && { [ -d node_modules ] || npm ci; } && npm run --silent build)
  (cd "$DESKTOP" && { [ -d node_modules ] || npm ci; })
  rm -rf "$TAURI/gen/apple"
  (cd "$DESKTOP" && npm run --silent tauri -- ios init --ci </dev/null)
  (cd "$DESKTOP" && npm run --silent tauri -- ios build --target aarch64-sim --debug --ci </dev/null)
}

app_path() {
  ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/sharecut-*/Build/Products/debug-iphonesimulator/*.app 2>/dev/null | head -n 1
}

launch() {
  local app id
  app="$(app_path)"
  [ -n "$app" ] || { echo "ios_sim: no built .app; run build first" >&2; exit 1; }
  id="$(bundle_identifier)"
  xcrun simctl boot "$DEVICE" 2>/dev/null || true
  xcrun simctl bootstatus "$DEVICE" -b >/dev/null
  xcrun simctl terminate "$DEVICE" "$id" 2>/dev/null || true
  xcrun simctl install "$DEVICE" "$app"
  mkdir -p "$LOG_DIR"
  xcrun simctl launch --stdout="$LOG_DIR/stdout.log" --stderr="$LOG_DIR/stderr.log" "$DEVICE" "$id"
}

proof() {
  (cd "$ROOT" && uv run python scripts/ios/sim_proof.py --device "$DEVICE" \
    --app "$(app_path)" --bundle-id "$(bundle_identifier)" \
    ${IOS_SIM_PROOF_DIR:+--evidence-dir "$IOS_SIM_PROOF_DIR"} \
    ${IOS_SIM_UI_WINDOW:+--ui-window "$IOS_SIM_UI_WINDOW"})
}

case "${1:-run}" in
  proof) proof ;;
  build) build; app_path ;;
  launch) launch ;;
  run) build; launch ;;
  *) echo "usage: ios_sim.sh run|build|launch" >&2; exit 2 ;;
esac
