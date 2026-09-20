from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULTS_PATH = _REPO_ROOT / ".agents" / "defaults" / "pipeline.yaml"


def repo_root() -> Path:
    return _REPO_ROOT


def cache_dir() -> Path:
    base = Path(os.environ.get("PODCAST_MCP_CACHE", Path.home() / ".cache" / "podcast_mcp"))
    base.mkdir(parents=True, exist_ok=True)
    return base


def whisper_cache_dir() -> Path:
    d = cache_dir() / "whisper"
    d.mkdir(parents=True, exist_ok=True)
    return d


def bin_cache_dir() -> Path:
    """Where bootstrapped native binaries (e.g. ffmpeg/ffprobe) are cached."""
    d = cache_dir() / "bin"
    d.mkdir(parents=True, exist_ok=True)
    return d


def models_dir() -> Path:
    """Where bootstrapped model assets (e.g. RNNoise `.rnnn` files) are cached."""
    d = cache_dir() / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_defaults() -> dict[str, Any]:
    override = os.environ.get("PODCAST_MCP_PIPELINE_DEFAULTS")
    path = Path(override).expanduser() if override else _DEFAULTS_PATH
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        from podcast_mcp.whisper_models import apply_whisper_model_to_defaults

        apply_whisper_model_to_defaults(data)
        return data
    return {}
