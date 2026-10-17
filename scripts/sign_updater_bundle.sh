#!/usr/bin/env bash
# Sign one shipped bundle with the Tauri updater key, writing <file>.sig.
# The key lives only in this process's environment: builds run without it.
# Usage: TAURI_SIGNING_PRIVATE_KEY=<content|path> [TAURI_SIGNING_PRIVATE_KEY_PASSWORD=…] \
#        scripts/sign_updater_bundle.sh <file>
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
file="${1:?usage: sign_updater_bundle.sh <file>}"
if [[ ! -s "$file" ]]; then
  echo "error: bundle to sign is missing or empty: $file" >&2
  exit 1
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "error: signing an updater bundle needs TAURI_SIGNING_PRIVATE_KEY (key content or path)" >&2
  exit 1
fi
# Empty password for a passwordless key; never prompt.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"

file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$ROOT/gui/desktop/src-tauri/tauri.conf.json")"
cli_file="$file"
if command -v cygpath >/dev/null 2>&1; then
  cli_file="$(cygpath -w "$file")"
fi

rm -f "$file.sig"
(
  cd "$ROOT/gui/desktop"
  npm run --silent tauri -- signer sign --app-version "$version" "$cli_file" >/dev/null </dev/null
)
if [[ ! -s "$file.sig" ]]; then
  echo "error: signing produced no signature for $(basename "$file")" >&2
  exit 1
fi
echo "signed $(basename "$file") (version $version)"
