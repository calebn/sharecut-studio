#!/usr/bin/env bash
# Smoke: extract an AppImage and prove the frozen sidecar serves /api/health.
# Does not drive WebKit (no display). Catches "runtime missing / Python crash"
# which is the same failure as WebView ERR_CONNECTION_REFUSED.
set -euo pipefail

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
cleanup() {
  if [[ -n "${SIDECAR_PID}" ]]; then
    # Kill the process group so nested Python/uvicorn does not keep :8765.
    kill -- "-${SIDECAR_PID}" 2>/dev/null || kill "${SIDECAR_PID}" 2>/dev/null || true
    wait "${SIDECAR_PID}" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

cd "$WORKDIR"
chmod +x "$IMG" || true
"$IMG" --appimage-extract >/dev/null
SIDECAR="squashfs-root/usr/bin/sharecut-sidecar"
if [[ ! -x "$SIDECAR" ]]; then
  echo "error: sharecut-sidecar not found at $SIDECAR" >&2
  find squashfs-root -name '*sidecar*' -o -name '*sharecut*' | head >&2 || true
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
