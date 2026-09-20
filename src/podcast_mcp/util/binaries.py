"""Resolve and (optionally) bootstrap the native FFmpeg/FFprobe binaries.

Resolution order for normal use (``resolve_ffmpeg`` / ``resolve_ffprobe``) is:

1. Explicit env override (``PODCAST_MCP_FFMPEG`` / ``PODCAST_MCP_FFPROBE``).
2. A system install on ``PATH`` (e.g. Homebrew, apt, a manual install).
3. A previously bootstrapped copy in the app cache dir (see ``bootstrap_ffmpeg``).
4. The literal command name, so behavior for anyone without FFmpeg at all is
   unchanged from before this module existed (a clear "not found" error from
   the subprocess call site).

This keeps the common case (FFmpeg already on PATH) a zero-cost PATH lookup,
and only touches the cache dir when PATH lookup fails. Nothing here downloads
anything on its own -- that only happens via ``bootstrap_ffmpeg``, which is
wired to the explicit `podcast bootstrap` CLI command so first-run cost is
opt-in and visible, never a surprise blocking network call.
"""

from __future__ import annotations

import logging
import platform
import shutil
from os import environ
from pathlib import Path

from podcast_mcp.config import bin_cache_dir

logger = logging.getLogger(__name__)


def _exe_suffix() -> str:
    return ".exe" if platform.system() == "Windows" else ""


def _cached_binary(name: str) -> Path | None:
    path = bin_cache_dir() / f"{name}{_exe_suffix()}"
    return path if path.is_file() else None


def resolve_ffmpeg() -> str:
    """Best-known ffmpeg path: env override > system PATH > bootstrap cache > 'ffmpeg'."""
    if override := environ.get("PODCAST_MCP_FFMPEG"):
        return override
    if found := shutil.which("ffmpeg"):
        return found
    if cached := _cached_binary("ffmpeg"):
        return str(cached)
    return "ffmpeg"


def resolve_ffprobe() -> str:
    """Best-known ffprobe path: env override > system PATH > bootstrap cache > 'ffprobe'."""
    if override := environ.get("PODCAST_MCP_FFPROBE"):
        return override
    if found := shutil.which("ffprobe"):
        return found
    if cached := _cached_binary("ffprobe"):
        return str(cached)
    return "ffprobe"


def ffmpeg_source(resolved_path: str) -> str:
    """Classify a resolved path for `podcast doctor`/`bootstrap` reporting."""
    if resolved_path in ("ffmpeg", "ffprobe"):
        return "not found"
    if str(bin_cache_dir()) in resolved_path:
        return "bundled"
    return "system"


def bootstrap_ffmpeg(*, force: bool = False) -> tuple[Path, Path]:
    """Download static ffmpeg/ffprobe binaries into the bootstrap cache dir.

    Requires the optional `static-ffmpeg` package (the `bootstrap` extra) --
    only this function imports it, so normal resolution never pays that cost.
    Copies the resolved binaries into our own cache dir so ``resolve_ffmpeg``/
    ``resolve_ffprobe`` never need to know about `static_ffmpeg`'s internals.
    """
    from podcast_mcp.util.asset_sources import (
        AssetSourceError,
        bootstrap_cdn_base,
        cdn_url_for,
        download_first_ok,
        ffmpeg_cdn_pins,
        ffmpeg_cdn_relative_paths,
    )

    dest_ffmpeg = bin_cache_dir() / f"ffmpeg{_exe_suffix()}"
    dest_ffprobe = bin_cache_dir() / f"ffprobe{_exe_suffix()}"
    if dest_ffmpeg.is_file() and dest_ffprobe.is_file() and not force:
        return dest_ffmpeg, dest_ffprobe

    cdn_base = bootstrap_cdn_base()
    pins: tuple[str, str] | None = None
    try:
        pins = ffmpeg_cdn_pins()
    except AssetSourceError:
        pins = None
    if cdn_base and pins:
        ff_rel, fp_rel = ffmpeg_cdn_relative_paths()
        ff_url = cdn_url_for("ffmpeg", ff_rel)
        fp_url = cdn_url_for("ffmpeg", fp_rel)
        if ff_url and fp_url:
            try:
                download_first_ok([ff_url], dest_ffmpeg, expected_sha256=pins[0])
                dest_ffmpeg.chmod(0o755)
                download_first_ok([fp_url], dest_ffprobe, expected_sha256=pins[1])
                dest_ffprobe.chmod(0o755)
                return dest_ffmpeg, dest_ffprobe
            except (AssetSourceError, OSError) as exc:
                logger.warning("CDN ffmpeg failed (%s); falling back to static-ffmpeg", exc)
                dest_ffmpeg.unlink(missing_ok=True)
                dest_ffprobe.unlink(missing_ok=True)
    elif cdn_base and not pins:
        logger.warning("skipping ffmpeg CDN: no sha256_by_platform pins")

    try:
        from static_ffmpeg import run
    except ImportError as exc:
        raise ImportError(
            "static-ffmpeg is required to bootstrap ffmpeg. "
            "Install with: pip install 'podcast-mcp[bootstrap]'"
        ) from exc

    src_ffmpeg, src_ffprobe = run.get_or_fetch_platform_executables_else_raise()
    shutil.copy2(src_ffmpeg, dest_ffmpeg)
    shutil.copy2(src_ffprobe, dest_ffprobe)
    dest_ffmpeg.chmod(0o755)
    dest_ffprobe.chmod(0o755)
    return dest_ffmpeg, dest_ffprobe
