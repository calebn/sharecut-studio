"""Whisper model catalog, machine preference, and cache detection.

Product default is ``large-v3-turbo`` (lowest practical WER). Smaller sizes
remain selectable at setup so machines that cannot spare ~1.6 GB still work.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

DEFAULT_WHISPER_MODEL = "large-v3-turbo"

# Official faster-whisper size ids (plus ``turbo`` alias).
FASTER_WHISPER_SIZES: frozenset[str] = frozenset(
    {
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
        "large-v1",
        "large-v2",
        "large-v3",
        "large-v3-turbo",
        "distil-large-v2",
        "distil-large-v3",
        "distil-medium.en",
        "distil-small.en",
        "turbo",
    }
)

_ALIASES: dict[str, str] = {
    "turbo": DEFAULT_WHISPER_MODEL,
    "large-v3-turbo": DEFAULT_WHISPER_MODEL,
}

# First-run / install picker. Default is first matching DEFAULT_WHISPER_MODEL.
WHISPER_MODEL_CATALOG: tuple[dict[str, str], ...] = (
    {
        "id": "tiny.en",
        "label": "Fastest (English)",
        "size": "~75 MB",
        "description": "Lowest accuracy. Drafts only.",
    },
    {
        "id": "base.en",
        "label": "Lightweight (English)",
        "size": "~150 MB",
        "description": "Smaller download; more ASR holes on overlapping speech.",
    },
    {
        "id": "small.en",
        "label": "Balanced (English)",
        "size": "~500 MB",
        "description": "Good laptop default if disk is tight.",
    },
    {
        "id": "medium.en",
        "label": "High quality (English)",
        "size": "~1.5 GB",
        "description": "Strong English WER; weaker on mixed-language episodes.",
    },
    {
        "id": "large-v3-turbo",
        "label": "Recommended",
        "size": "~1.6 GB",
        "description": "Lowest practical error for podcasts (multilingual). Default.",
    },
    {
        "id": "large-v3",
        "label": "Maximum accuracy",
        "size": "~3 GB",
        "description": "Slightly better than turbo; much slower and larger.",
    },
)

WHISPER_MODEL_IDS: tuple[str, ...] = tuple(item["id"] for item in WHISPER_MODEL_CATALOG)
WHISPER_SIZE_ENUM: tuple[str, ...] = tuple(sorted(FASTER_WHISPER_SIZES))


def prefs_path() -> Path:
    from podcast_mcp.config import cache_dir

    return cache_dir() / "prefs.yaml"


def normalize_whisper_model(model: str) -> str:
    raw = (model or "").strip()
    if not raw:
        raise ValueError("Whisper model is empty")
    key = raw.lower()
    return _ALIASES.get(key, key)


def validate_whisper_model(model: str) -> str:
    """Return a canonical faster-whisper size or raise ValueError."""
    normalized = normalize_whisper_model(model)
    if normalized not in FASTER_WHISPER_SIZES:
        allowed = ", ".join(WHISPER_SIZE_ENUM)
        raise ValueError(f"Unknown Whisper model {model!r}. Choose from: {allowed}")
    return normalized


def _env_whisper_model() -> str | None:
    env = os.environ.get("PODCAST_WHISPER_MODEL")
    if not env or not env.strip():
        return None
    try:
        return validate_whisper_model(env)
    except ValueError:
        return None


def _prefs_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def read_whisper_model_pref() -> str | None:
    path = prefs_path()
    if not path.is_file():
        return None
    data = _prefs_mapping(path)
    value = data.get("whisper_model")
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return validate_whisper_model(value)
    except ValueError:
        return None


def persist_whisper_model(model: str) -> str:
    """Write the machine Whisper preference under the cache dir."""
    canonical = validate_whisper_model(model)
    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = _prefs_mapping(path)
    existing["whisper_model"] = canonical
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(
        yaml.safe_dump(existing, sort_keys=True, allow_unicode=True),
        encoding="utf-8",
    )
    os.replace(tmp, path)
    return canonical


def resolve_whisper_model(*, requested: str | None = None) -> str:
    """Precedence: explicit request → env → prefs.yaml → product default."""
    if requested is not None and str(requested).strip():
        return validate_whisper_model(requested)
    env = _env_whisper_model()
    if env:
        return env
    pref = read_whisper_model_pref()
    if pref:
        return pref
    return DEFAULT_WHISPER_MODEL


def apply_whisper_model_to_defaults(defaults: dict[str, Any]) -> dict[str, Any]:
    """Overlay env/prefs onto pipeline defaults; keep YAML when neither is set."""
    transcribe = defaults.setdefault("transcribe", {})
    if not isinstance(transcribe, dict):
        return defaults
    overlay = _env_whisper_model() or read_whisper_model_pref()
    if overlay:
        transcribe["model"] = overlay
    elif not transcribe.get("model"):
        transcribe["model"] = DEFAULT_WHISPER_MODEL
    return defaults


class WhisperWeightsMissingError(RuntimeError):
    """Raised when a pipeline/transcribe run needs weights that are not on disk."""

    def __init__(self, model: str) -> None:
        self.model = model
        super().__init__(
            f"Whisper model {model!r} is not downloaded. "
            f"Run: podcast bootstrap --component whisper --whisper-model {model} "
            "or use a downloaded model with "
            "podcast transcribe --model <model>."
        )


def ensure_whisper_model_cached(model: str) -> str:
    """Return the canonical model id, or raise if weights are missing."""
    canonical = validate_whisper_model(model)
    if not whisper_model_is_cached(canonical):
        raise WhisperWeightsMissingError(canonical)
    return canonical


def bootstrap_whisper_model(model_size: str) -> dict[str, Any]:
    """Download weights into the cache and persist the machine preference."""
    from faster_whisper import WhisperModel

    from podcast_mcp.config import whisper_cache_dir

    canonical = validate_whisper_model(model_size)
    # Intentional download path — the only WhisperModel construction without
    # local_files_only=True.
    WhisperModel(
        canonical,
        device="cpu",
        compute_type="int8",
        download_root=str(whisper_cache_dir()),
    )
    persist_error: str | None = None
    try:
        persist_whisper_model(canonical)
    except (OSError, yaml.YAMLError) as exc:
        persist_error = str(exc)
    return {
        "ok": True,
        "model": canonical,
        "cache": str(whisper_cache_dir()),
        "persist_error": persist_error,
    }


def cache_path_matches_model(posix: str, model: str) -> bool:
    """True when a faster-whisper cache path belongs to ``model`` (not a prefix)."""
    p = posix.lower().replace("\\", "/")
    m = normalize_whisper_model(model)
    if m == "large-v3" and "large-v3-turbo" in p:
        return False
    escaped = re.escape(m)
    return re.search(rf"(?:faster-whisper-|{re.escape('--')}){escaped}(?:/|$)", p) is not None


_WEIGHT_NAMES = frozenset({"model.bin", "model.safetensors"})


def whisper_model_is_cached(model: str) -> bool:
    """True when a complete-looking faster-whisper weight file is on disk.

    Requires ``model.bin`` or ``model.safetensors`` under a path that belongs to
    ``model`` so a partial Hugging Face download does not count as ready.
    """
    from podcast_mcp.config import whisper_cache_dir

    root = whisper_cache_dir()
    if not root.is_dir():
        return False
    canonical = validate_whisper_model(model)
    return any(
        path.is_file()
        and path.name in _WEIGHT_NAMES
        and cache_path_matches_model(path.as_posix(), canonical)
        for path in root.rglob("*")
    )


def catalog_payload() -> list[dict[str, Any]]:
    """Catalog rows for setup + Pipeline pickers, including on-disk ``cached``."""
    return [
        {
            **dict(item),
            "cached": whisper_model_is_cached(item["id"]),
        }
        for item in WHISPER_MODEL_CATALOG
    ]
