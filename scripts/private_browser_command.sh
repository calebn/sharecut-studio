#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# == 0 || -z ${RUNNER_TEMP:-} || ! -d $RUNNER_TEMP ]]; then
  printf '%s\n' 'Browser command capture could not be initialized.' >&2
  exit 2
fi
if ! private_dir=$(mktemp -d "$RUNNER_TEMP/browser-private.XXXXXX" 2>/dev/null); then
  printf '%s\n' 'Browser command capture could not be initialized.' >&2
  exit 2
fi

for channel in GITHUB_STEP_SUMMARY GITHUB_OUTPUT GITHUB_ENV GITHUB_PATH GITHUB_STATE; do
  export "$channel=$private_dir/$channel"
done
if [[ -n ${BROWSER_RAW_REPORT:-} ]]; then
  if [[ ! $BROWSER_RAW_REPORT =~ ^playwright-report/[a-zA-Z0-9_-]+\.json$ ||
    -z ${BROWSER_CAPTURE_RECEIPT:-} ||
    ! ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ||
    ! ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] ||
    ! rm -f -- "$BROWSER_CAPTURE_RECEIPT" 2>"$private_dir/capture-error.log" ||
    ! rm -f -- "$BROWSER_RAW_REPORT" 2>"$private_dir/capture-error.log"; then
    printf '%s\n' 'Browser command capture could not be initialized.' >&2
    exit 2
  fi
  if ! printf '%s %s\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" >"$BROWSER_CAPTURE_RECEIPT"; then
    printf '%s\n' 'Browser command capture could not be initialized.' >&2
    exit 2
  fi
fi
printf '%s\n' 'Browser diagnostics remain on the runner; only the allowlisted result projection is published.'
# exec preserves the existing command's exit and signal/teardown lifecycle.
exec "$@" >"$private_dir/console.log" 2>&1
