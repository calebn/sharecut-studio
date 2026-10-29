#!/usr/bin/env bash
# Smoke: extract an AppImage and prove the frozen sidecar serves /api/health.
# Does not drive WebKit (no display). Catches "runtime missing / Python crash"
# which is the same failure as WebView ERR_CONNECTION_REFUSED.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap 'echo "error: smoke failed at line $LINENO: $BASH_COMMAND" >&2' ERR

# Run a command to completion before matching its output: `cmd | grep -q` under
# pipefail fails when grep exits first and the writer gets SIGPIPE.
prints_usage() {
  local out
  out="$("$@" 2>&1)" || return 1
  grep -q "Usage" <<<"$out"
}

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /path/to/SharecutStudio_*.AppImage" >&2
  exit 2
fi
IMG="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [[ ! -f "$IMG" ]]; then
  echo "error: AppImage not found: $1" >&2
  exit 1
fi

if curl -fsS --max-time 1 http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
  echo "error: 127.0.0.1:8765 already serves /api/health — stop other Sharecut GUI processes" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
SIDECAR_PID=""
stop_sidecar() {
  if [[ -n "${SIDECAR_PID}" ]]; then
    # Kill the process group so nested Python/uvicorn does not keep :8765.
    kill -- "-${SIDECAR_PID}" 2>/dev/null || kill "${SIDECAR_PID}" 2>/dev/null || true
    wait "${SIDECAR_PID}" 2>/dev/null || true
  fi
}
on_exit stop_sidecar
on_exit 'rm -rf "$WORKDIR"'

cd "$WORKDIR"
chmod +x "$IMG" || true
"$IMG" --appimage-extract >/dev/null
SIDECAR="squashfs-root/usr/bin/sharecut-sidecar"
if [[ ! -x "$SIDECAR" ]]; then
  echo "error: sharecut-sidecar not found at $SIDECAR" >&2
  find squashfs-root -name '*sidecar*' -o -name '*sharecut*' | head >&2 || true
  exit 1
fi

for stem in podcast podcast-mcp; do
  cli="squashfs-root/usr/bin/$stem"
  if [[ ! -x "$cli" ]]; then
    echo "error: $stem not found at $cli" >&2
    exit 1
  fi
done
prints_usage "squashfs-root/usr/bin/podcast" --help
"squashfs-root/usr/bin/podcast-mcp" --help >/dev/null

# Exercise the public AppImage entry point, before Tauri/WebKit starts.
echo "==> AppImage --cli/--mcp"
if ! prints_usage "$IMG" --cli --help; then
  echo "error: AppImage --cli --help did not print CLI usage" >&2
  exit 1
fi
"$IMG" --mcp --help >/dev/null
"$IMG" --cli info --project "$ROOT/tests/fixtures/aligned_dialogue/episode.sharecut" >/dev/null
outer_gui_status=0
timeout 60 "$IMG" --cli --no-progress gui --no-open >/dev/null 2>&1 || outer_gui_status=$?
if [[ "$outer_gui_status" -ne 2 ]]; then
  echo "error: AppImage --cli gui exited $outer_gui_status (want 2 refusal)" >&2
  exit 1
fi

echo "==> sharecut-sidecar --cli --help"
if ! prints_usage "$SIDECAR" --cli --help; then
  echo "error: sharecut-sidecar --cli --help did not print CLI usage" >&2
  exit 1
fi
# Root options before `gui` must not slip past the packaged-CLI refusal.
cli_gui_status=0
timeout 60 "$SIDECAR" --cli --no-progress gui --no-open >/dev/null 2>&1 || cli_gui_status=$?
if [[ "$cli_gui_status" -ne 2 ]]; then
  echo "error: sharecut-sidecar --cli --no-progress gui exited $cli_gui_status (want 2 refusal)" >&2
  exit 1
fi

set -m
"$SIDECAR" &
SIDECAR_PID=$!
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 http://127.0.0.1:8765/api/health | grep -q '"ok"'; then
    if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
      echo "error: sharecut-sidecar exited after health responded (possible port squat)" >&2
      exit 1
    fi
    echo "linux AppImage sidecar health OK"
    exit 0
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    echo "error: sharecut-sidecar exited before health" >&2
    exit 1
  fi
  sleep 1
done
echo "error: timed out waiting for /api/health" >&2
exit 1
