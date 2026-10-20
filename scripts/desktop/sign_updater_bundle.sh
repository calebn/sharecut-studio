#!/usr/bin/env bash
# Sign one shipped bundle with the Tauri updater key, writing <file>.sig.
# The key lives only in this process's environment: builds run without it.
# Usage: TAURI_SIGNING_PRIVATE_KEY=<content|existing file path> [TAURI_SIGNING_PRIVATE_KEY_PASSWORD=…] \
#        scripts/desktop/sign_updater_bundle.sh <file>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set +x

file="${1:?usage: sign_updater_bundle.sh <file>}"
if [[ ! -s "$file" ]]; then
  echo "error: bundle to sign is missing or empty: $file" >&2
  exit 1
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "error: signing an updater bundle needs TAURI_SIGNING_PRIVATE_KEY (key content or path)" >&2
  exit 1
fi
# The CLI reads a key file only from ..._PATH, so a path given as the key itself
# is passed that way. Key content is passed through untouched; nothing is printed.
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$TAURI_SIGNING_PRIVATE_KEY" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$TAURI_SIGNING_PRIVATE_KEY"
  unset TAURI_SIGNING_PRIVATE_KEY
fi
# Empty password for a passwordless key; never prompt.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"

file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
version="$(tauri_version)"
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
