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
  xcrun stapler validate "${extracted[0]}"
fi
echo "$OUT/$name"
