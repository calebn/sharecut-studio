# shellcheck shell=bash
# Shared preamble for every scripts/desktop/*.sh. Source it first:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# tests/test_desktop_scripts_lib.py fails when a script in this directory does not.
#
# Provides, with no side effects beyond the shell options, the EXIT trap and the
# variables below:
#   ROOT                     repo root (two levels above this file)
#   on_exit CMD              run CMD (eval'd, in registration order) when the script exits;
#                            the script's exit status survives the cleanup
#   desktop_arch             aarch64 | x64 | the raw `uname -m` (Tauri bundle naming)
#   tauri_version            "version" of gui/desktop/src-tauri/tauri.conf.json
#   run_notarytool ARGS...   `xcrun notarytool submit ARGS...`, killed after NOTARY_WAIT_SEC
#   staple_with_retries PATH staple and validate PATH, retrying while Apple's ticket
#                            service lags (STAPLE_ATTEMPTS, STAPLE_RETRY_DELAY)
# Needs bash 3.2 (macOS): no associative arrays, no `${empty[@]}` under `set -u`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOTARY_WAIT_SEC="${NOTARY_WAIT_SEC:-2700}"

_on_exit_cmds=()

on_exit() {
  _on_exit_cmds+=("$1")
}

_run_on_exit() {
  local rc=$? i
  trap - EXIT
  for ((i = 0; i < ${#_on_exit_cmds[@]}; i++)); do
    eval "${_on_exit_cmds[i]}" || true
  done
  exit "$rc"
}
trap _run_on_exit EXIT

desktop_arch() {
  case "$(uname -m)" in
    arm64) echo aarch64 ;;
    x86_64) echo x64 ;;
    *) uname -m ;;
  esac
}

tauri_version() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$ROOT/gui/desktop/src-tauri/tauri.conf.json"
}

run_notarytool() {
  perl -e 'alarm shift; exec @ARGV' "$NOTARY_WAIT_SEC" xcrun notarytool submit "$@"
}

# stapler fetches the ticket from Apple CloudKit, which drops connections on CI
# runners, and the ticket can trail an Accepted notarization by a minute or two.
# Output goes to stderr so callers that print a path on stdout stay clean.
staple_with_retries() {
  local target="$1" attempts="${STAPLE_ATTEMPTS:-8}" delay="${STAPLE_RETRY_DELAY:-20}" n=1
  until xcrun stapler staple "$target" >&2 && xcrun stapler validate "$target" >&2; do
    if ((n >= attempts)); then
      echo "error: could not staple a notarization ticket to $target after $n attempts" >&2
      return 1
    fi
    echo "stapling attempt $n/$attempts failed; retrying in ${delay}s" >&2
    sleep "$delay"
    n=$((n + 1))
  done
}
