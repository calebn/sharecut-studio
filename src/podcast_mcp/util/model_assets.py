"""Resolve and (optionally) bootstrap small downloadable model assets.

The RNNoise `.rnnn` model used by FFmpeg's `arnndn` filter (the
`noise_reduction_rnnoise` preset).
Silero VAD needs no entry here: its ONNX model already ships inside
`faster-whisper` (a core dependency), so there is nothing to download -- see
`podcast_mcp.engines.vad_silero`. The forced word aligner lives in
`podcast_mcp.engines.models.word_aligner` (a pinned Hugging Face snapshot, like
the Whisper tiers).

Like `util/binaries.py`, nothing here downloads anything on import; only the
explicit `bootstrap_*` functions (wired to `podcast bootstrap`) touch the
network.
"""

from __future__ import annotations

import logging
from pathlib import Path

from podcast_mcp import settings
from podcast_mcp.config.defaults import models_dir
from podcast_mcp.util.asset_sources import (
    AssetSourceError,
    OnProgress,
    asset_entry,
    bootstrap_cdn_base,
    download_first_ok,
    ordered_http_urls,
)
from podcast_mcp.util.model_manifest import manifest_mismatch

logger = logging.getLogger(__name__)

RNNOISE_MODEL_NAME = "somnolent-hogwash.rnnn"


def rnnoise_override() -> Path | None:
    """A user-supplied model file (``PODCAST_MCP_RNNOISE_MODEL``)."""
    override = settings.raw("PODCAST_MCP_RNNOISE_MODEL")
    return Path(override).expanduser() if override else None


def rnnoise_model_path() -> Path:
    if (override := rnnoise_override()) is not None:
        return override
    return models_dir() / RNNOISE_MODEL_NAME


def resolve_rnnoise_model() -> Path:
    """Path to a ready-to-use RNNoise model, or raise with a bootstrap hint."""
    path = rnnoise_model_path()
    if path.is_file():
        return path
    raise FileNotFoundError(
        f"RNNoise model not found at {path}. Run `podcast bootstrap --component rnnoise`."
    )


def rnnoise_pin() -> str | None:
    """The pinned sha256 of the default model, or None when unpinned or the manifest is unreadable."""
    try:
        sha = asset_entry("rnnoise").get("sha256")
    except AssetSourceError:
        return None
    return sha.strip().lower() if isinstance(sha, str) and sha.strip() else None


def rnnoise_pin_mismatch(path: Path, *, memoize: bool) -> str | None:
    """Why the default model is not the pinned file, or None. A user override is never checked."""
    if rnnoise_override() is not None or (pin := rnnoise_pin()) is None:
        return None
    return manifest_mismatch(path.parent, ((path.name, pin),), memoize=memoize)


def bootstrap_rnnoise_model(*, force: bool = False, on_progress: OnProgress | None = None) -> Path:
    """Download the RNNoise model into the cache dir, skipping a present file that matches the pin."""
    path = rnnoise_model_path()
    if path.is_file() and not force and rnnoise_pin_mismatch(path, memoize=False) is None:
        return path
    meta = asset_entry("rnnoise")
    filename = str(meta.get("filename") or RNNOISE_MODEL_NAME)
    urls = ordered_http_urls("rnnoise", relative_path=filename)
    sha = meta.get("sha256")
    expected = str(sha).lower() if isinstance(sha, str) and sha.strip() else None
    base = bootstrap_cdn_base()
    if base and not expected:
        urls = [url for url in urls if not (url == base or url.startswith(f"{base}/"))]
        logger.warning("rnnoise CDN skipped: no sha256 pin")
    if not urls:
        raise AssetSourceError("rnnoise has no download source in contracts/bootstrap-assets.json")
    download_first_ok(urls, path, expected_sha256=expected, on_progress=on_progress)
    verify_pinned_size(path, meta.get("size_bytes"))
    return path


def verify_pinned_size(path: Path, size_bytes: object) -> None:
    """Manifest-consistency tripwire: the sha256 check already implies the size."""
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool):
        return
    got = path.stat().st_size
    if got != size_bytes:
        # Unlink, otherwise the is_file() early return would accept the bad file forever.
        path.unlink(missing_ok=True)
        raise AssetSourceError(
            f"size mismatch for {path.name}: expected {size_bytes} bytes, got {got}"
        )
