"""Resolve and (optionally) bootstrap small downloadable model assets.

Currently just the RNNoise `.rnnn` model used by FFmpeg's `arnndn` filter
(the `noise_reduction_rnnoise` preset). Silero VAD needs no entry here: its
ONNX model already ships inside `faster-whisper` (a core dependency), so
there is nothing to download -- see `podcast_mcp.engines.vad_silero`.

Like `util/binaries.py`, nothing here downloads anything on import; only the
explicit `bootstrap_*` functions (wired to `podcast bootstrap`) touch the
network.
"""

from __future__ import annotations

import logging
import shutil
import urllib.parse
import urllib.request
from os import environ
from pathlib import Path

from podcast_mcp.config import models_dir
from podcast_mcp.util.asset_sources import (
    asset_entry,
    bootstrap_cdn_base,
    download_first_ok,
    ordered_http_urls,
)

logger = logging.getLogger(__name__)

RNNOISE_MODEL_URL = (
    "https://raw.githubusercontent.com/GregorR/rnnoise-models/"
    "master/somnolent-hogwash-2018-09-01/sh.rnnn"
)
RNNOISE_MODEL_NAME = "somnolent-hogwash.rnnn"

# NISQA (FOSS speech quality) - weights tarball placeholder URL (operators may
# override with PODCAST_MCP_NISQA_MODEL pointing at an unpacked weights dir).
NISQA_MODEL_URL = "https://github.com/gabrielmittag/NISQA/releases/download/v1.0/nisqa.tar.gz"
NISQA_MODEL_NAME = "nisqa"


def _download(url: str, dest: Path, *, timeout: float = 60.0) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"refusing non-http(s) download URL: {url!r}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    try:
        req = urllib.request.Request(url, method="GET")
        with (
            urllib.request.urlopen(req, timeout=timeout) as resp,  # nosec B310
            tmp.open("wb") as f,
        ):
            shutil.copyfileobj(resp, f)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


def rnnoise_model_path() -> Path:
    if override := environ.get("PODCAST_MCP_RNNOISE_MODEL"):
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
        urls = [RNNOISE_MODEL_URL]
    download_first_ok(urls, path, expected_sha256=expected)
    return path


def nisqa_model_path() -> Path:
    if override := environ.get("PODCAST_MCP_NISQA_MODEL"):
        return Path(override).expanduser()
    return models_dir() / NISQA_MODEL_NAME


def resolve_nisqa_model() -> Path:
    """Path to NISQA weights dir/file, or raise with bootstrap hint."""
    path = nisqa_model_path()
    if path.exists():
        return path
    raise FileNotFoundError(
        f"NISQA model not found at {path}. Run `podcast bootstrap --component nisqa` "
        "or set PODCAST_MCP_NISQA_MODEL (optional joinqc extra)."
    )


def bootstrap_nisqa_model(*, force: bool = False) -> Path:
    """Download NISQA weights archive into the models cache (best-effort)."""
    import tarfile

    path = nisqa_model_path()
    if path.exists() and not force:
        return path
    archive = models_dir() / "nisqa.tar.gz"
    _download(NISQA_MODEL_URL, archive, timeout=180.0)
    path.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        # filter="data" blocks path traversal / special files (PEP 706).
        tf.extractall(path, filter="data")
    return path
