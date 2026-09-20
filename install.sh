#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

WHISPER_MODEL=""
BOOTSTRAP_WHISPER=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--whisper-model NAME] [--bootstrap-whisper]

  --whisper-model NAME   Persist the machine Whisper model (default: large-v3-turbo).
                         Options: tiny.en, base.en, small.en, medium.en,
                         large-v3-turbo, large-v3 (alias: turbo).
  --bootstrap-whisper    Also download that model now (otherwise first transcribe
                         fetches it lazily).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --whisper-model)
      WHISPER_MODEL="${2:?--whisper-model requires a name}"
      shift 2
      ;;
    --whisper-model=*)
      WHISPER_MODEL="${1#*=}"
      shift
      ;;
    --bootstrap-whisper)
      BOOTSTRAP_WHISPER=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if command -v uv >/dev/null 2>&1; then
  # Contributor default: tests + GUI API + bootstrap FFmpeg + relay.
  # Omits speaker/joinqc (large torch/CUDA downloads). For those: uv sync --all-extras
  uv sync --extra dev --extra gui --extra bootstrap --extra relay
  PODCAST=(uv run podcast)
else
  if [ ! -d .venv ]; then
    python3 -m venv .venv
  fi
  .venv/bin/pip install -e ".[dev,gui,bootstrap,relay]" -q
  PODCAST=(.venv/bin/podcast)
fi

if [ -n "$WHISPER_MODEL" ]; then
  "${PODCAST[@]}" setup --whisper-model "$WHISPER_MODEL"
else
  "${PODCAST[@]}" setup
fi

if [ "$BOOTSTRAP_WHISPER" = 1 ]; then
  if [ -n "$WHISPER_MODEL" ]; then
    "${PODCAST[@]}" bootstrap --component whisper --whisper-model "$WHISPER_MODEL"
  else
    "${PODCAST[@]}" bootstrap --component whisper
  fi
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config core.hooksPath .githooks
  chmod +x .githooks/pre-commit .githooks/pre-push
fi

echo
echo "Activate the venv (or prefix with uv run) before calling podcast:"
echo "  source .venv/bin/activate"
echo "  podcast doctor"
echo "No system FFmpeg?  podcast bootstrap --component ffmpeg"
echo "Whisper model:     podcast bootstrap --component whisper   # default large-v3-turbo"
echo "                   ./install.sh --whisper-model small.en     # smaller, higher WER"
echo "Git hooks (lint-staged + pre-push make ci gate): make hooks  # needs: cd gui/web && npm ci"
