#!/usr/bin/env bash
# Build the macOS updater tarball from the signed and notarized .app, laid out
# exactly like Tauri's own updater tarball (the .app directory at the archive
# root, gzip), and named <Product>_<version>_<arch>.app.tar.gz so Intel and
# Apple Silicon bundles can share one feed directory. For a signed build, extract
# the tarball and prove the app inside is validly signed and stapled.
# Prints the tarball path. Usage: scripts/stage_updater_bundle.sh <output-dir>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: stage_updater_bundle.sh <output-dir>}"
# A reused checkout must not publish an older tarball next to the new one.
if [[ -d "$OUT" ]]; then
  rm -f "$OUT"/*.app.tar.gz "$OUT"/*.app.tar.gz.sig
fi
macos_dir="$ROOT/gui/desktop/src-tauri/target/release/bundle/macos"
shopt -s nullglob
apps=("$macos_dir"/*.app)
if [[ ${#apps[@]} -ne 1 ]]; then
  echo "error: expected exactly one .app in $macos_dir, found ${#apps[@]}" >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x64 ;;
  *) arch="$(uname -m)" ;;
esac
version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$ROOT/gui/desktop/src-tauri/tauri.conf.json")"
app_name="$(basename "${apps[0]}")"
stem="${app_name%.app}"
name="${stem//[[:space:]]/}_${version}_${arch}.app.tar.gz"

# Apple's ticket service can lag a minute or two behind an Accepted notarization,
# so the stapling Tauri does at bundle time sometimes leaves the app without a
# ticket. Staple again (with retries) before archiving so the tarball always
# carries a ticket.
tree_fingerprint() {
  (
    cd "$1"
    find . -type f -exec shasum -a 256 {} + | sort -k2
    find . -type l -exec sh -c 'for l; do printf "%s -> %s\n" "$l" "$(readlink "$l")"; done' sh {} + | sort
  )
}
ensure_stapled() {
  local app="$1" attempts="${STAPLE_ATTEMPTS:-8}" delay="${STAPLE_RETRY_DELAY:-20}" n=1
  while :; do
    if xcrun stapler staple "$app" >&2 && xcrun stapler validate "$app" >&2; then
      return 0
    fi
    if ((n >= attempts)); then
      echo "error: could not staple a notarization ticket to $app after $n attempts" >&2
      return 1
    fi
    echo "stapling attempt $n/$attempts failed; retrying in ${delay}s" >&2
    sleep "$delay"
    n=$((n + 1))
  done
}
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  ensure_stapled "${apps[0]}"
fi

mkdir -p "$OUT"
rm -f "$OUT/$name" "$OUT/$name.sig"
COPYFILE_DISABLE=1 tar -C "$macos_dir" -czf "$OUT/$name" "$app_name"

check="$(mktemp -d "${TMPDIR:-/tmp}/updater-verify.XXXXXX")"
trap 'rm -rf "$check"' EXIT
tar -xzf "$OUT/$name" -C "$check"
extracted=("$check"/*)
if [[ ${#extracted[@]} -ne 1 || "$(basename "${extracted[0]}")" != "$app_name" ]]; then
  echo "error: tarball must hold only $app_name at its root" >&2
  exit 1
fi
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign --verify --deep --strict "${extracted[0]}"
  # stapler validate can reach out to Apple when it runs on a copy, and those
  # lookups drop on CI runners. The source app was just stapled and validated, so
  # a few validate attempts that fail only on the network are covered by proving
  # the archive round-trips the app unchanged.
  validated=no
  for attempt in 1 2 3; do
    if xcrun stapler validate "${extracted[0]}" >&2; then
      validated=yes
      break
    fi
    sleep "${STAPLE_RETRY_DELAY:-20}"
  done
  if [[ "$validated" != yes ]]; then
    if [[ "$(tree_fingerprint "${apps[0]}")" != "$(tree_fingerprint "${extracted[0]}")" ]]; then
      echo "error: the archived app differs from the stapled app and has no valid ticket" >&2
      exit 1
    fi
    echo "warning: stapler validate failed on the extracted app; it is identical to the stapled source app" >&2
  fi
fi
echo "$OUT/$name"
