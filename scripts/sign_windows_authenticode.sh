#!/usr/bin/env bash
# Sign (or verify) Windows Authenticode files on a GitHub-hosted runner.
# Imports the PFX into the current-user store and signs by thumbprint so the
# PFX password never appears on the signtool command line.
set -euo pipefail
set +x

usage() {
  echo "usage: $0 [--verify] FILE [FILE...]" >&2
  exit 1
}

verify_only=0
if [[ "${1:-}" == "--verify" ]]; then
  verify_only=1
  shift
fi
if [[ $# -lt 1 ]]; then
  usage
fi

find_signtool() {
  local candidate signtool=""
  for candidate in "/c/Program Files (x86)/Windows Kits/10/bin/"*/x64/signtool.exe; do
    if [[ -f "$candidate" ]]; then
      signtool="$candidate"
    fi
  done
  if [[ -z "$signtool" ]]; then
    echo "error: signtool.exe not found on the Windows runner" >&2
    exit 1
  fi
  printf '%s' "$signtool"
}

win_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$path"
  else
    printf '%s' "$path"
  fi
}

verify_files() {
  local signtool="$1"
  shift
  local f
  for f in "$@"; do
    if [[ ! -f "$f" ]]; then
      echo "error: not a file: $f" >&2
      exit 1
    fi
    "$signtool" verify /pa "$(win_path "$f")"
  done
}

signtool="$(find_signtool)"

if [[ "$verify_only" -eq 1 ]]; then
  verify_files "$signtool" "$@"
  exit 0
fi

: "${WINDOWS_SIGN_CERT_PFX_B64:?WINDOWS_SIGN_CERT_PFX_B64 is required}"
: "${WINDOWS_SIGN_CERT_PASSWORD:?WINDOWS_SIGN_CERT_PASSWORD is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

pfx="${RUNNER_TEMP}/sharecut-authenticode-$$.pfx"
thumbprint=""
imported=0

cleanup() {
  if [[ "$imported" -eq 1 && "$thumbprint" =~ ^[A-Fa-f0-9]{40}$ ]]; then
    powershell.exe -NoProfile -NonInteractive -Command \
      "Get-ChildItem Cert:\\CurrentUser\\My\\${thumbprint} -ErrorAction SilentlyContinue | Remove-Item" \
      >/dev/null 2>&1 || true
  fi
  rm -f "$pfx"
}
trap cleanup EXIT

printf '%s' "$WINDOWS_SIGN_CERT_PFX_B64" | base64 --decode > "$pfx"
chmod 600 "$pfx"

export PFX_WINDOWS_PATH
PFX_WINDOWS_PATH="$(win_path "$pfx")"
thumbprint="$(
  powershell.exe -NoProfile -NonInteractive -Command '
    $ErrorActionPreference = "Stop"
    $pass = ConvertTo-SecureString -String $env:WINDOWS_SIGN_CERT_PASSWORD -AsPlainText -Force
    $certs = @(Import-PfxCertificate -FilePath $env:PFX_WINDOWS_PATH -CertStoreLocation Cert:\CurrentUser\My -Password $pass)
    $leaf = $certs | Where-Object { $_.HasPrivateKey } | Select-Object -First 1
    if (-not $leaf) { throw "PFX import produced no private-key certificate" }
    [Console]::Out.WriteLine($leaf.Thumbprint.Trim())
  ' | tr -d "\r" | grep -E "^[A-Fa-f0-9]{40}$" | tail -n 1
)" || true

if [[ ! "$thumbprint" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo "error: failed to import Authenticode PFX" >&2
  exit 1
fi
imported=1

for f in "$@"; do
  if [[ ! -f "$f" ]]; then
    echo "error: not a file: $f" >&2
    exit 1
  fi
  "$signtool" sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 "$thumbprint" "$(win_path "$f")"
done

verify_files "$signtool" "$@"
