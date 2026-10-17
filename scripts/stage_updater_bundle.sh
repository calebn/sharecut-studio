#!/usr/bin/env bash
# Stage the macOS Tauri updater tarball (+ .sig) under an architecture-specific
# name so Intel and Apple Silicon bundles can share one feed directory, then,
# for a signed build, prove the tarball holds a valid, stapled app.
# Usage: scripts/stage_updater_bundle.sh <output-dir>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: stage_updater_bundle.sh <output-dir>}"
macos_dir="$ROOT/gui/desktop/src-tauri/target/release/bundle/macos"
shopt -s nullglob
tarballs=("$macos_dir"/*.app.tar.gz)
if [[ ${#tarballs[@]} -ne 1 || ! -s "${tarballs[0]}.sig" ]]; then
  echo "error: expected one .app.tar.gz with a non-empty .sig in $macos_dir" >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x64 ;;
  *) arch="$(uname -m)" ;;
esac
version="$(python3 -c "import json; print(json.load(open('$ROOT/gui/desktop/src-tauri/tauri.conf.json'))['version'])")"
stem="$(basename "${tarballs[0]}" .app.tar.gz)"
name="${stem//[[:space:]]/}_${version}_${arch}.app.tar.gz"

mkdir -p "$OUT"
cp "${tarballs[0]}" "$OUT/$name"
cp "${tarballs[0]}.sig" "$OUT/$name.sig"

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  check="$(mktemp -d "${TMPDIR:-/tmp}/updater-verify.XXXXXX")"
  trap 'rm -rf "$check"' EXIT
  tar -xzf "$OUT/$name" -C "$check"
  apps=("$check"/*.app)
  [[ ${#apps[@]} -eq 1 ]] || { echo "error: tarball must hold exactly one .app" >&2; exit 1; }
  codesign --verify --deep --strict "${apps[0]}"
  xcrun stapler validate "${apps[0]}"
fi
echo "staged $OUT/$name (+ .sig)"
