#!/usr/bin/env bash
# Local Tauri installer build (not required CI). Needs Rust + platform WebView deps.
# macOS: signs and notarizes the .app when APPLE_SIGNING_IDENTITY + notarization env
# are set, then packs a DMG with hdiutil retries (never re-submit the .app to Apple).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DIST_PROFILE="$(resolve_distribution_profile)"
cd "$ROOT"

DIST_OVERLAY="$ROOT/gui/desktop/src-tauri/target/distribution/tauri.conf.json"
python3 "$ROOT/scripts/generate_distribution_config.py" \
  --profile "$DIST_PROFILE" --output "$DIST_OVERLAY"

# The updater private key is held back from every build step and handed only to
# scripts/desktop/sign_updater_artifacts.sh at the end. SHARECUT_SKIP_UPDATER_ARTIFACTS=1
# builds without an update bundle even when the profile has an updater.
signing_env=()
for name in TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if [[ -n "${!name:-}" ]]; then
    signing_env+=("$name=${!name}")
  fi
  unset "$name"
done
sign_updater=0
profile_has_updater() {
  python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("updater_public_key") else 1)' "$DIST_PROFILE"
}
if [[ "${SHARECUT_SKIP_UPDATER_ARTIFACTS:-}" != "1" ]] && profile_has_updater; then
  sign_updater=1
  if [[ ${#signing_env[@]} -eq 0 ]]; then
    echo "error: this profile has an updater; the signing step needs TAURI_SIGNING_PRIVATE_KEY" >&2
    echo "       (key content or path). Set SHARECUT_SKIP_UPDATER_ARTIFACTS=1 to skip it." >&2
    exit 1
  fi
fi
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
    "$ROOT/scripts/desktop/pack_macos_dmg.sh"
  else
    npm run tauri -- build --config "$DIST_OVERLAY"
  fi
)

if [[ "$sign_updater" == "1" ]]; then
  echo "==> Sign updater bundle"
  env "${signing_env[@]}" "$ROOT/scripts/desktop/sign_updater_artifacts.sh"
fi

echo "desktop build OK — see gui/desktop/src-tauri/target/release/bundle/"
