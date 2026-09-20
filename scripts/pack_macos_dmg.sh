#!/usr/bin/env bash
# Pack an already-built distribution .app into a UDZO DMG.
# Retries hdiutil only — does not re-run Tauri or Apple notarization of the .app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$ROOT/gui/desktop/src-tauri/tauri.conf.json"
NOTARY_WAIT_SEC="${NOTARY_WAIT_SEC:-2700}"

default_arch() {
  case "$(uname -m)" in
    arm64) echo aarch64 ;;
    x86_64) echo x64 ;;
    *) echo "$(uname -m)" ;;
  esac
}

if [[ $# -ge 1 ]]; then
  APP="$1"
else
  shopt -s nullglob
  apps=("$ROOT"/gui/desktop/src-tauri/target/release/bundle/macos/*.app)
  if [[ ${#apps[@]} -ne 1 ]]; then
    echo "error: expected exactly one macOS app bundle, found ${#apps[@]}" >&2
    exit 1
  fi
  APP="${apps[0]}"
fi
product_name="$(basename "$APP" .app)"
compact_name="${product_name//[[:space:]]/}"
if [[ -z "$compact_name" ]]; then
  echo "error: app bundle name must contain a non-space character" >&2
  exit 1
fi
if [[ $# -ge 2 ]]; then
  OUT="$2"
else
  version="$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['version'])")"
  OUT="$ROOT/gui/desktop/src-tauri/target/release/bundle/dmg/${compact_name}_${version}_$(default_arch).dmg"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: pack_macos_dmg.sh is macOS-only" >&2
  exit 1
fi
if [[ ! -d "$APP" ]]; then
  echo "error: app bundle not found: $APP" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
staging="$(mktemp -d "${TMPDIR:-/tmp}/distribution-dmg.XXXXXX")"
# hdiutil appends .dmg when the dest has no .dmg suffix, so keep the temp path
# as *.partial.dmg (otherwise codesign looks at *.partial and the image is
# left as *.partial.dmg). Preserve the original exit status in the EXIT trap;
# a successful cleanup must not mask a failed codesign/notarytool.
partial="${OUT}.partial.dmg"
hdiutil_pid=""

cleanup() {
  if [[ -n "${hdiutil_pid:-}" ]] && kill -0 "$hdiutil_pid" 2>/dev/null; then
    kill "$hdiutil_pid" 2>/dev/null || true
    wait "$hdiutil_pid" 2>/dev/null || true
  fi
  rm -rf "$staging"
  rm -f "$partial"
}
trap 'rc=$?; cleanup; exit "$rc"' EXIT

detach_partial() {
  local path="$1"
  local dev
  dev="$(
    hdiutil info 2>/dev/null | awk -v p="$path" '
      $1 == "image-path" {
        img = $0
        sub(/^image-path[[:space:]]*:[[:space:]]*/, "", img)
      }
      /^\/dev\// && img == p { print $1; exit }
    '
  )"
  if [[ -n "$dev" ]]; then
    echo "detaching $dev from failed create…"
    hdiutil detach "$dev" -force || true
  fi
}

ditto "$APP" "$staging/${product_name}.app"
ln -s /Applications "$staging/Applications"

rm -f "$partial"
attempt=1
max_attempts=6
while true; do
  echo "hdiutil create attempt ${attempt}/${max_attempts}…"
  hdiutil create \
    -volname "$product_name" \
    -srcfolder "$staging" \
    -ov \
    -format UDZO \
    -fs HFS+ \
    "$partial" &
  hdiutil_pid=$!
  if wait "$hdiutil_pid"; then
    hdiutil_pid=""
    break
  fi
  hdiutil_pid=""
  detach_partial "$partial"
  rm -f "$partial"
  if ((attempt >= max_attempts)); then
    echo "error: hdiutil create failed after ${max_attempts} attempts (DiskArbitration busy?)" >&2
    exit 1
  fi
  sleep_s=$((10 * attempt))
  echo "waiting ${sleep_s}s before retry…"
  sleep "$sleep_s"
  attempt=$((attempt + 1))
done

have_api_notarize() {
  [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" ]]
}

have_apple_id_notarize() {
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]
}

run_notarytool() {
  perl -e 'alarm shift; exec @ARGV' "$NOTARY_WAIT_SEC" xcrun notarytool submit "$@"
}

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "==> codesign DMG"
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$partial"
  if have_api_notarize; then
    key_path="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8}"
    if [[ ! -f "$key_path" ]]; then
      echo "error: App Store Connect API key not found: $key_path" >&2
      exit 1
    fi
    echo "==> notarize + staple DMG (not the .app — already notarized separately)"
    run_notarytool "$partial" --wait --output-format json \
      --key-id "$APPLE_API_KEY" \
      --key "$key_path" \
      --issuer "$APPLE_API_ISSUER"
  elif have_apple_id_notarize; then
    echo "==> notarize + staple DMG (not the .app — already notarized separately)"
    run_notarytool "$partial" --wait --output-format json \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID"
  else
    echo "error: signed DMG requires notarization credentials (APPLE_API_KEY+APPLE_API_ISSUER or APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID)" >&2
    exit 1
  fi
  xcrun stapler staple "$partial"
  xcrun stapler validate "$partial"
fi

mv -f "$partial" "$OUT"
echo "DMG: $OUT"
shasum -a 256 "$OUT"
