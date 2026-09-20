#!/usr/bin/env bash
# Mirror `.github/workflows/desktop.yml` → desktop-scaffold (local + CI).
# No Rust coverage % gate. Clippy/tests use --lib --no-default-features
# so Tauri/GTK/WebKit are not required on the runner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Verify Tauri tree"
test -f gui/desktop/src-tauri/Cargo.toml
test -f gui/desktop/src-tauri/tauri.conf.json
test -f gui/desktop/src-tauri/src/main.rs
test -f gui/desktop/src-tauri/src/lib.rs
test -f gui/desktop/src-tauri/src/share_url.rs
test -f gui/desktop/src-tauri/src/sidecar.rs
test -f gui/desktop/src-tauri/src/media_capture.rs
test -f gui/desktop/src-tauri/Info.plist
test -f gui/desktop/src-tauri/Entitlements.plist
test -f gui/desktop/README.md
test -x gui/desktop/binaries/sharecut-sidecar
test -f scripts/build_sidecar.py
test -f scripts/sidecar_launcher.rs
python3 -c "import json; json.load(open('gui/desktop/src-tauri/tauri.conf.json'))"
python3 scripts/generate_distribution_config.py \
  --profile config/distribution.dev.json \
  --output "${TMPDIR:-/tmp}/sharecut-tauri-distribution-check.json"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found — install Rust (https://rustup.rs/) with rustfmt + clippy" >&2
  exit 1
fi

cd gui/desktop/src-tauri

echo "==> cargo fmt --check"
cargo fmt --check

echo "==> cargo clippy --lib --no-default-features"
cargo clippy --lib --no-default-features -- -D warnings

echo "==> cargo test --lib --no-default-features"
cargo test --lib --no-default-features

# Ubuntu scaffold cannot compile WebView FFI (needs WebKitGTK / WebView2).
# On macOS, typecheck the app binary so media_capture.rs is not an uncompiled island.
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> cargo clippy --bin sharecut --features app (macOS WebView adapters)"
  python3 "$ROOT/scripts/tauri_sidecar_hook.py" --dev-stub
  cargo clippy --bin sharecut --features app -- -D warnings
fi

echo "desktop check OK"
