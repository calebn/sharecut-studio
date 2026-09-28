from __future__ import annotations

import copy
import math
import os
from collections.abc import Mapping
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


def word_aligner_cache_dir() -> Path:
    """Hugging Face cache for the opt-in forced aligner (`podcast bootstrap --component word-aligner`)."""
    d = cache_dir() / "word-aligner"
    d.mkdir(parents=True, exist_ok=True)
    return d


_PARSED_DEFAULTS: dict[str, tuple[bytes, dict[str, Any]]] = {}


def _parsed_defaults(path: Path) -> dict[str, Any]:
    """A private copy of *path*'s parsed YAML, re-parsed only when the file's bytes change.

    Comparing bytes (not mtime/size) catches a same-length edit saved within a coarse
    filesystem's mtime granularity; reading the small file is cheap, parsing it is not.
    """
    raw = path.read_bytes()
    key = str(path)
    hit = _PARSED_DEFAULTS.get(key)
    if hit is None or hit[0] != raw:
        hit = (raw, yaml.safe_load(raw.decode("utf-8")) or {})
        _PARSED_DEFAULTS[key] = hit
    return copy.deepcopy(hit[1])


def load_defaults() -> dict[str, Any]:
    """Pipeline defaults (``PODCAST_MCP_PIPELINE_DEFAULTS`` or the repo YAML) with the Whisper overlay.

    The YAML is parsed once per change to the file's contents; each caller gets its own copy.
    """
    override = os.environ.get("PODCAST_MCP_PIPELINE_DEFAULTS")
    path = Path(override).expanduser() if override else _DEFAULTS_PATH
    if path.is_file():
        data = _parsed_defaults(path)
        from podcast_mcp.whisper_models import apply_whisper_model_to_defaults

        apply_whisper_model_to_defaults(data)
        return data
    return {}


DEFAULT_PREMIX_PEAK_CEILING_DB = -1.0


def mix_peak_ceiling_db(defaults: Mapping[str, Any] | None = None) -> float:
    """True-peak ceiling (dBTP) the premix, bounce and compose sums are trimmed under.

    ``defaults`` is a pipeline config (a run's merged config); None reads ``load_defaults()``.
    """
    cfg = load_defaults() if defaults is None else defaults
    mix = cfg.get("mix") or {}
    return float(mix.get("premix_peak_ceiling_db", DEFAULT_PREMIX_PEAK_CEILING_DB))


DEFAULT_MICRO_FADE_MS = 10


def join_micro_fade_ms(defaults: Mapping[str, Any] | None = None) -> int:
    """Declick micro-fade (ms) at a join: ``inaudible_cuts.micro_fade_ms``.

    ``defaults`` is a pipeline config; None reads ``load_defaults()``.
    """
    cfg = load_defaults() if defaults is None else defaults
    return int((cfg.get("inaudible_cuts") or {}).get("micro_fade_ms", DEFAULT_MICRO_FADE_MS))


def bounded_float(value: Any, default: float, lo: float, hi: float) -> float:
    """Parse a numeric config value, clamped to ``[lo, hi]``; ``default`` if invalid."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return max(lo, min(hi, parsed))
