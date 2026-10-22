"""Resolve and (optionally) bootstrap small downloadable model assets.

The RNNoise `.rnnn` model used by FFmpeg's `arnndn` filter (the
`noise_reduction_rnnoise` preset), plus the path of user-supplied NISQA weights.
Silero VAD needs no entry here: its ONNX model already ships inside
`faster-whisper` (a core dependency), so there is nothing to download -- see
`podcast_mcp.engines.vad_silero`. The opt-in forced word aligner lives in
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
    asset_entry,
    bootstrap_cdn_base,
    download_first_ok,
    ordered_http_urls,
)

logger = logging.getLogger(__name__)

RNNOISE_MODEL_NAME = "somnolent-hogwash.rnnn"

NISQA_MODEL_NAME = "nisqa"


def rnnoise_model_path() -> Path:
    if override := settings.raw("PODCAST_MCP_RNNOISE_MODEL"):
        return Path(override).expanduser()
    return models_dir() / RNNOISE_MODEL_NAME


def resolve_rnnoise_model() -> Path:
    """Path to a ready-to-use RNNoise model, or raise with a bootstrap hint."""
    path = rnnoise_model_path()
    if path.is_file():
        return path
    raise FileNotFoundError(
        f"RNNoise model not found at {path}. Run `podcast bootstrap --component rnnoise`."
    )


def bootstrap_rnnoise_model(*, force: bool = False) -> Path:
    """Download the RNNoise model into the cache dir, skipping if already present."""
    path = rnnoise_model_path()
    if path.is_file() and not force:
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
    download_first_ok(urls, path, expected_sha256=expected)
    _verify_pinned_size(path, meta.get("size_bytes"))
    return path


def _verify_pinned_size(path: Path, size_bytes: object) -> None:
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


def nisqa_model_path() -> Path:
    if override := settings.raw("PODCAST_MCP_NISQA_MODEL"):
        return Path(override).expanduser()
    return models_dir() / NISQA_MODEL_NAME


def resolve_nisqa_model() -> Path:
    """Path to NISQA weights dir/file, or raise with bootstrap hint."""
    path = nisqa_model_path()
    if path.exists():
        return path
    raise FileNotFoundError(
        f"NISQA model not found at {path}. Set PODCAST_MCP_NISQA_MODEL to an unpacked "
        "weights directory (optional joinqc extra)."
    )
