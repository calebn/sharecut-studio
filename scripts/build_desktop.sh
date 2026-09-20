#!/usr/bin/env bash
# Local Tauri installer build (not required CI). Needs Rust + platform WebView deps.
# macOS: signs and notarizes the .app when APPLE_SIGNING_IDENTITY + notarization env
# are set, then packs a DMG with hdiutil retries (never re-submit the .app to Apple).
set -euo pipefail

CALLER_DIR="$PWD"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${PODCAST_DISTRIBUTION_PROFILE:-}" ]]; then
  DIST_PROFILE="$PODCAST_DISTRIBUTION_PROFILE"
  [[ "$DIST_PROFILE" = /* ]] || DIST_PROFILE="$CALLER_DIR/$DIST_PROFILE"
  DIST_PROFILE="$(cd "$(dirname "$DIST_PROFILE")" && pwd -P)/$(basename "$DIST_PROFILE")"
else
  DIST_PROFILE="$ROOT/config/distribution.dev.json"
fi
cd "$ROOT"

DIST_OVERLAY="$ROOT/gui/desktop/src-tauri/target/distribution/tauri.conf.json"
python3 "$ROOT/scripts/generate_distribution_config.py" \
  --profile "$DIST_PROFILE" --output "$DIST_OVERLAY"
export PODCAST_DISTRIBUTION_PROFILE="$DIST_PROFILE"
export PODCAST_DISTRIBUTION_TAURI_CONFIG="$DIST_OVERLAY"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found — install Rust (https://rustup.rs/)" >&2
  exit 1
fi

echo "==> Build Sharecut Studio web dist + freeze sidecar"
(
  cd gui/web
  if [[ ! -d node_modules ]]; then
    npm ci
  fi
  npm run build
)

python3 "$ROOT/scripts/build_sidecar.py"

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "==> Tauri build (signed/notarized if APPLE_API_* present)"
else
  echo "==> Tauri build (unsigned; set APPLE_SIGNING_IDENTITY to codesign)"
fi
(
  cd gui/desktop
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    # --bundles app only: Tauri notarizes+staples the .app once. Retrying
    # `build --bundles dmg` re-signs and re-submits to Apple (minutes each).
    npm run tauri -- build --bundles app --config "$DIST_OVERLAY"
    "$ROOT/scripts/pack_macos_dmg.sh"
  else
    npm run tauri -- build --config "$DIST_OVERLAY"
  fi
)

echo "desktop build OK — see gui/desktop/src-tauri/target/release/bundle/"
