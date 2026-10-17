#!/usr/bin/env bash
# Sign the updater bundle of the installer this host just built. CI and the
# local operator path both run this after the build, so they produce identical
# artifacts and the build itself never holds the updater private key.
#   macOS   tar.gz of the signed+notarized .app  -> bundle/updater/<Product>_<ver>_<arch>.app.tar.gz(.sig)
#   Windows the final NSIS *-setup.exe (after any Authenticode) -> <file>.sig
#   Linux   the AppImage -> <file>.sig
# Needs TAURI_SIGNING_PRIVATE_KEY (content or path) and optionally
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD in the environment of this process only.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bundle_dir="$ROOT/gui/desktop/src-tauri/target/release/bundle"
shopt -s nullglob

one_of() {
  if [[ $# -ne 1 ]]; then
    echo "error: expected exactly one updater bundle, found $#" >&2
    exit 1
  fi
  printf '%s\n' "$1"
}

case "$(uname -s)" in
  Darwin)
    bundle="$("$ROOT/scripts/stage_updater_bundle.sh" "$bundle_dir/updater")"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    bundle="$(one_of "$bundle_dir"/nsis/*-setup.exe)"
    ;;
  Linux)
    bundle="$(one_of "$bundle_dir"/appimage/*.AppImage)"
    ;;
  *)
    echo "error: unsupported host $(uname -s)" >&2
    exit 1
    ;;
esac
"$ROOT/scripts/sign_updater_bundle.sh" "$bundle"
