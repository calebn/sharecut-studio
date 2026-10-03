"""Resolve and (optionally) bootstrap the native FFmpeg/FFprobe binaries.

Explicit constructor arguments and nonempty environment overrides take
precedence. Automatic selection prefers the native Homebrew keg on macOS.
Pair consumers then use the first complete executable PATH directory, followed
by a complete cache pair. Single-command consumers can use an individual PATH
or cached command, or a literal command name for subprocess error reporting.

Resolution never runs commands, inspects versions, or downloads binaries.
Downloads require the explicit ``bootstrap_ffmpeg`` operation. Release and
source policy is documented in ``docs/setup.md``.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
from dataclasses import dataclass
from os import environ
from pathlib import Path
from typing import Literal

from podcast_mcp.config import bin_cache_dir

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FFmpegPair:
    """Selected commands, including intentionally mixed explicit overrides."""

    ffmpeg: str
    ffprobe: str

    def is_available(self) -> bool:
        """Check that both commands are executable without running them."""
        return all(shutil.which(command) is not None for command in (self.ffmpeg, self.ffprobe))


class FFmpegPairResolutionError(RuntimeError):
    """Raised when a pair consumer cannot resolve both executable commands."""


def _pair_in(directory: Path) -> FFmpegPair | None:
    directory = directory.absolute()
    suffix = _exe_suffix()
    ffmpeg = directory / f"ffmpeg{suffix}"
    ffprobe = directory / f"ffprobe{suffix}"
    if all(path.is_file() and os.access(path, os.X_OK) for path in (ffmpeg, ffprobe)):
        return FFmpegPair(str(ffmpeg), str(ffprobe))
    return None


def _native_homebrew_pair() -> FFmpegPair | None:
    if platform.system() != "Darwin":
        return None
    prefix = {"arm64": Path("/opt/homebrew"), "x86_64": Path("/usr/local")}.get(platform.machine())
    return _pair_in(prefix / "opt" / "ffmpeg" / "bin") if prefix else None


def _automatic_pair() -> FFmpegPair | None:
    if native := _native_homebrew_pair():
        return native
    for entry in environ.get("PATH", os.defpath).split(os.pathsep):
        if pair := _pair_in(Path(entry or os.curdir)):
            return pair
    return _pair_in(bin_cache_dir())


def _explicit_value(value: str | None, variable: str) -> str | None:
    return value if value is not None else environ.get(variable) or None


def _executable_sibling(command: str, sibling: str) -> str | None:
    if not os.path.dirname(command):
        return None
    path = Path(command).absolute()
    candidate = path.parent / f"{sibling}{_exe_suffix()}"
    return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None


def resolve_ffmpeg_pair(ffmpeg: str | None = None, ffprobe: str | None = None) -> FFmpegPair:
    """Resolve a complete pair, preserving explicit command strings exactly."""
    selected_ffmpeg = _explicit_value(ffmpeg, "PODCAST_MCP_FFMPEG")
    selected_ffprobe = _explicit_value(ffprobe, "PODCAST_MCP_FFPROBE")
    if selected_ffmpeg is not None and selected_ffprobe is not None:
        return FFmpegPair(selected_ffmpeg, selected_ffprobe)

    if selected_ffmpeg is not None:
        sibling = _executable_sibling(selected_ffmpeg, "ffprobe")
        if sibling:
            return FFmpegPair(selected_ffmpeg, sibling)
    if selected_ffprobe is not None:
        sibling = _executable_sibling(selected_ffprobe, "ffmpeg")
        if sibling:
            return FFmpegPair(sibling, selected_ffprobe)

    automatic = _automatic_pair()
    if automatic is None:
        raise FFmpegPairResolutionError(
            "FFmpeg and FFprobe were not found as an executable pair. "
            "Install FFmpeg or run `podcast bootstrap --component ffmpeg`."
        )
    return FFmpegPair(
        selected_ffmpeg if selected_ffmpeg is not None else automatic.ffmpeg,
        selected_ffprobe if selected_ffprobe is not None else automatic.ffprobe,
    )


def _exe_suffix() -> str:
    return ".exe" if platform.system() == "Windows" else ""


def _cached_binary(name: str) -> Path | None:
    path = bin_cache_dir() / f"{name}{_exe_suffix()}"
    return path if path.is_file() else None


def _resolve_single(name: Literal["ffmpeg", "ffprobe"]) -> str:
    if override := environ.get(f"PODCAST_MCP_{name.upper()}"):
        return override
    if pair := _native_homebrew_pair():
        return pair.ffmpeg if name == "ffmpeg" else pair.ffprobe
    if found := shutil.which(name):
        return found
    if cached := _cached_binary(name):
        return str(cached)
    return name


def resolve_ffmpeg() -> str:
    """Resolve one command using overrides, native Homebrew, PATH, then cache."""
    return _resolve_single("ffmpeg")


def resolve_ffprobe() -> str:
    """Resolve one command using overrides, native Homebrew, PATH, then cache."""
    return _resolve_single("ffprobe")


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
    if FFmpegPair(str(dest_ffmpeg), str(dest_ffprobe)).is_available() and not force:
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
                if not FFmpegPair(str(dest_ffmpeg), str(dest_ffprobe)).is_available():
                    raise OSError("downloaded FFmpeg/FFprobe pair is not executable")
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
    try:
        shutil.copy2(src_ffmpeg, dest_ffmpeg)
        shutil.copy2(src_ffprobe, dest_ffprobe)
        dest_ffmpeg.chmod(0o755)
        dest_ffprobe.chmod(0o755)
    except OSError:
        dest_ffmpeg.unlink(missing_ok=True)
        dest_ffprobe.unlink(missing_ok=True)
        raise
    if not FFmpegPair(str(dest_ffmpeg), str(dest_ffprobe)).is_available():
        dest_ffmpeg.unlink(missing_ok=True)
        dest_ffprobe.unlink(missing_ok=True)
        raise OSError("bootstrapped FFmpeg/FFprobe pair is not executable")
    return dest_ffmpeg, dest_ffprobe
