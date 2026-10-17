#!/usr/bin/env bash
# Freeze the Linux sidecar and bundle an unsigned AppImage.
# Used by gui/desktop/Dockerfile.linux-appimage and the ubuntu job in
# .github/workflows/release-desktop-build.yml. Iterate in Docker before GHA.
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

DIST_OVERLAY="$ROOT/gui/desktop/src-tauri/target/distribution/tauri-linux.conf.json"
python3 "$ROOT/scripts/generate_distribution_config.py" \
  --profile "$DIST_PROFILE" --output "$DIST_OVERLAY" --compact-product-name
export PODCAST_DISTRIBUTION_PROFILE="$DIST_PROFILE"

export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"
export NO_STRIP="${NO_STRIP:-true}"

if ! command -v xdg-mime >/dev/null 2>&1; then
  echo "==> Install xdg-utils (linuxdeploy needs xdg-mime)"
  debdir=""
  for candidate in /opt/sharecut-debs "$ROOT/gui/desktop/dist-linux/debs"; do
    if [[ -d "$candidate" ]] && compgen -G "$candidate"/*.deb >/dev/null; then
      debdir="$candidate"
      break
    fi
  done
  if [[ -n "$debdir" ]]; then
    dpkg -i "$debdir"/*.deb
  elif [[ "$(id -u)" -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq xdg-utils desktop-file-utils
  else
    echo "error: xdg-mime not found — install xdg-utils" >&2
    exit 1
  fi
fi

SIDECAR_OUT="${SHARECUT_SIDECAR_OUT:-$ROOT/gui/desktop/binaries}"
mkdir -p "$SIDECAR_OUT"

echo "==> Freeze sidecar into $SIDECAR_OUT"
if [[ -f "$SIDECAR_OUT/sharecut-runtime/.freeze-complete" && -x "$SIDECAR_OUT/sharecut-runtime/venv/bin/python" && "${REBUILD_SIDECAR:-}" != "1" ]]; then
  echo "    reusing existing freeze (set REBUILD_SIDECAR=1 to redo)"
else
  python3 "$ROOT/scripts/build_sidecar.py" --out "$SIDECAR_OUT"
fi
python3 "$ROOT/scripts/build_sidecar.py" --slim-only --out "$SIDECAR_OUT"

# linuxdeploy runs ldd on every ELF in the AppDir. Manylinux wheels vendor hashed
# .so files in *.libs without RPATH between siblings, so ldd needs this path.
echo "==> Wheel .libs on LD_LIBRARY_PATH (linuxdeploy/ldd)"
wheel_path=""
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  wheel_path="${wheel_path:+$wheel_path:}$dir"
done < <(find "$SIDECAR_OUT/sharecut-runtime" -type d -name '*.libs' | sort)
if [[ -n "$wheel_path" ]]; then
  export LD_LIBRARY_PATH="${wheel_path}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  echo "    $wheel_path"
fi

echo "==> Tauri AppImage"
bundle_root="${CARGO_TARGET_DIR:-$ROOT/gui/desktop/src-tauri/target}/release/bundle"
rm -rf "$bundle_root/appimage" "$bundle_root/appimage_deb"
(
  cd "$ROOT/gui/desktop"
  npm ci
  # Spaces in productName make linuxdeploy AppDir / .desktop names fail.
  # Do not merge extra bundle.resources keys — Tauri deep-merges and would
  # still walk the host ../binaries/sharecut-runtime (macOS freeze).
  npm run tauri -- build --bundles appimage --verbose --config "$DIST_OVERLAY"
)

echo "AppImage OK"
shopt -s nullglob
found=()
for dir in \
  "$ROOT/gui/desktop/src-tauri/target/release/bundle/appimage" \
  "${CARGO_TARGET_DIR:-}/release/bundle/appimage"
do
  [[ -d "$dir" ]] || continue
  for img in "$dir"/*.AppImage; do
    echo "  $img"
    found+=("$img")
  done
done
if [[ -n "${SHARECUT_APPIMAGE_OUT:-}" && -d "${SHARECUT_APPIMAGE_OUT}" ]]; then
  for img in "${found[@]}"; do
    cp -f "$img" "${SHARECUT_APPIMAGE_OUT}/"
    echo "copied $(basename "$img") → ${SHARECUT_APPIMAGE_OUT}/"
  done
fi
if [[ ${#found[@]} -eq 0 ]]; then
  echo "error: no AppImage produced" >&2
  exit 1
fi
if [[ "${SKIP_APPIMAGE_SMOKE:-}" != "1" ]]; then
  echo "==> AppImage sidecar health smoke"
  "$ROOT/scripts/smoke_linux_appimage.sh" "${found[0]}"
fi
