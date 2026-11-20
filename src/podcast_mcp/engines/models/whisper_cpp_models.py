"""The whisper.cpp model files an iPhone transcribes with, as the ``whisper`` registry row's variants.

Two quantized English files, each one pinned asset in ``contracts/bootstrap-assets.json``.
Everything keys off ``host_platform``: on any other host these functions are inert and the
faster-whisper catalog stays the only one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.config.defaults import cache_dir
from podcast_mcp.util import host_platform
from podcast_mcp.util.asset_sources import (
    AssetSourceError,
    OnProgress,
    asset_entry,
    download_first_ok,
    upstream_http_url,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_assets import verify_pinned_size


@dataclass(frozen=True)
class WhisperCppVariant:
    id: str
    filename: str
    asset_id: str
    quality: str
    size: str
    description: str


VARIANTS: tuple[WhisperCppVariant, ...] = (
    WhisperCppVariant(
        id="small.en-q5_1",
        filename="ggml-small.en-q5_1.bin",
        asset_id="whisper-cpp-small-en-q5_1",
        quality="Recommended",
        size="190 MB",
        description="Better accuracy; uses more storage and memory. English only.",
    ),
    WhisperCppVariant(
        id="base.en-q5_1",
        filename="ggml-base.en-q5_1.bin",
        asset_id="whisper-cpp-base-en-q5_1",
        quality="Less accurate",
        size="60 MB",
        description="Smaller download; expect more errors on fast or overlapping speech. "
        "English only.",
    ),
)
DEFAULT_VARIANT = VARIANTS[0].id
VARIANT_IDS: tuple[str, ...] = tuple(v.id for v in VARIANTS)
_BY_ID = {v.id: v for v in VARIANTS}


def on_whisper_cpp_host() -> bool:
    return host_platform.current().transcription == "whisper_cpp"


def whisper_cpp_cache_dir() -> Path:
    d = cache_dir() / "whisper-cpp" / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def variant_for(variant_id: str) -> WhisperCppVariant:
    try:
        return _BY_ID[variant_id]
    except KeyError:
        raise CodedValueError(
            f"Unknown whisper.cpp model {variant_id!r}. Choose from: {', '.join(VARIANT_IDS)}",
            code="invalid_request",
        ) from None


def variant_path(variant_id: str) -> Path:
    return whisper_cpp_cache_dir() / variant_for(variant_id).filename


def is_installed(variant_id: str) -> bool:
    return variant_path(variant_id).is_file()


def installed_default() -> str:
    """The default variant, unless only another one is on disk."""
    if is_installed(DEFAULT_VARIANT):
        return DEFAULT_VARIANT
    return next((v.id for v in VARIANTS if is_installed(v.id)), DEFAULT_VARIANT)


def coerce(model: str) -> str:
    """``model`` when it names a variant (or the host is not whisper.cpp); else the installed one.

    A faster-whisper id arrives here from the pipeline's own default; it never names a file.
    """
    if model in _BY_ID or not on_whisper_cpp_host():
        return model
    return installed_default()


def size_bytes(variant_id: str) -> int | None:
    try:
        pinned = asset_entry(variant_for(variant_id).asset_id).get("size_bytes")
    except AssetSourceError:  # a bad manifest must not break a status read
        return None
    return pinned if isinstance(pinned, int) else None


def catalog_payload() -> list[dict[str, Any]]:
    return [
        {
            "id": v.id,
            "label": v.quality,
            "size": v.size,
            "description": v.description,
            "cached": is_installed(v.id),
        }
        for v in VARIANTS
    ]


def bootstrap_variant(
    variant_id: str, *, force: bool = False, on_progress: OnProgress | None = None
) -> Path:
    """Download one variant's file into the cache, skipping it if present; no other file moves."""
    path = variant_path(variant_id)
    if path.is_file() and not force:
        return path
    meta = asset_entry(variant_for(variant_id).asset_id)
    url = upstream_http_url(variant_for(variant_id).asset_id)
    sha = meta.get("sha256")
    if not url or not isinstance(sha, str) or not sha.strip():
        raise AssetSourceError(f"{variant_id} has no pinned download in bootstrap-assets.json")
    download_first_ok([url], path, expected_sha256=sha.lower(), on_progress=on_progress)
    verify_pinned_size(path, meta.get("size_bytes"))
    return path
