"""Select and validate a supported FFmpeg 9 executable pair.

Build-time source archive delivery belongs to scripts/build_ffmpeg.py and never
participates in application runtime pair selection.

Explicit commands win, followed by a declared desktop bundle, native Homebrew,
a complete PATH directory, and the existing source-use cache. Selection runs
bounded version probes and never downloads tools.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
from collections.abc import Iterator
from dataclasses import dataclass
from os import environ
from pathlib import Path
from typing import Literal

from podcast_mcp.config import bin_cache_dir
from podcast_mcp.util.ffmpeg_policy import ffmpeg_policy
from podcast_mcp.util.process import TimeoutExpired, run

SelectionSource = Literal["explicit", "bundle", "homebrew", "path", "cache"]


@dataclass(frozen=True)
class FFmpegPair:
    """An admitted pair with equal supported upstream releases."""

    ffmpeg: str
    ffprobe: str
    version: tuple[int, int, int]
    source: SelectionSource

    def is_available(self) -> bool:
        return all(shutil.which(command) is not None for command in (self.ffmpeg, self.ffprobe))


class FFmpegPairResolutionError(RuntimeError):
    """A missing, invalid, or unsupported native executable pair."""


_INSTALL_HINT = (
    "Install matching FFmpeg and FFprobe 9.0.2 or later 9.x, or build the pinned pair "
    "with `python scripts/build_ffmpeg.py --output <directory>` and set "
    "PODCAST_MCP_FFMPEG and PODCAST_MCP_FFPROBE to its bin executables."
)
_VERSION = re.compile(r"^(ffmpeg|ffprobe) version (\d+)\.(\d+)(?:\.(\d+))?(?:\s|$)")


def _version(command: str, name: str) -> tuple[int, int, int]:
    try:
        result = run([command, "-version"], capture_output=True, text=True, timeout=10)
    except (OSError, TimeoutExpired) as exc:
        raise FFmpegPairResolutionError(f"Cannot run {command!r}: {exc}. {_INSTALL_HINT}") from exc
    match = _VERSION.match(result.stdout or "")
    if result.returncode or match is None or match[1] != name:
        raise FFmpegPairResolutionError(
            f"{command!r} did not report a numeric {name} 9 release. {_INSTALL_HINT}"
        )
    version = (int(match[2]), int(match[3]), int(match[4] or 0))
    policy = ffmpeg_policy()
    if version[0] != policy["supported_major"] or version < tuple(policy["minimum_version"]):
        raise FFmpegPairResolutionError(
            f"{command!r} reports unsupported {'.'.join(map(str, version))}. {_INSTALL_HINT}"
        )
    return version


def _validate(ffmpeg: str, ffprobe: str, source: SelectionSource) -> FFmpegPair:
    ffmpeg = str(Path(shutil.which(ffmpeg) or ffmpeg).absolute())
    ffprobe = str(Path(shutil.which(ffprobe) or ffprobe).absolute())
    version = _version(ffmpeg, "ffmpeg")
    probe_version = _version(ffprobe, "ffprobe")
    if version != probe_version:
        raise FFmpegPairResolutionError(
            f"FFmpeg and FFprobe releases must match: {ffmpeg!r} reports {version}, "
            f"{ffprobe!r} reports {probe_version}. {_INSTALL_HINT}"
        )
    return FFmpegPair(
        str(Path(shutil.which(ffmpeg) or ffmpeg).absolute()),
        str(Path(shutil.which(ffprobe) or ffprobe).absolute()),
        version,
        source,
    )


def _exe_suffix() -> str:
    return ".exe" if platform.system() == "Windows" else ""


def _pair_in(directory: Path) -> tuple[str, str] | None:
    directory = directory.absolute()
    commands = tuple(directory / f"{name}{_exe_suffix()}" for name in ("ffmpeg", "ffprobe"))
    try:
        if all(path.is_file() and os.access(path, os.X_OK) for path in commands):
            return str(commands[0]), str(commands[1])
    except OSError:
        return None
    return None


def _native_homebrew_pair() -> tuple[str, str] | None:
    if platform.system() != "Darwin":
        return None
    prefix = {"arm64": Path("/opt/homebrew"), "x86_64": Path("/usr/local")}.get(platform.machine())
    return _pair_in(prefix / "opt" / "ffmpeg" / "bin") if prefix else None


def _automatic_candidates() -> Iterator[tuple[tuple[str, str] | None, SelectionSource]]:
    yield _native_homebrew_pair(), "homebrew"
    for entry in environ.get("PATH", os.defpath).split(os.pathsep):
        yield _pair_in(Path(entry or os.curdir)), "path"
    yield _pair_in(bin_cache_dir()), "cache"


def _automatic_pair() -> FFmpegPair:
    failures: list[str] = []
    for commands, source in _automatic_candidates():
        if commands is not None:
            try:
                return _validate(*commands, source)
            except FFmpegPairResolutionError as exc:
                failures.append(str(exc))
    detail = " ".join(failures) or "FFmpeg and FFprobe were not found as an executable pair."
    raise FFmpegPairResolutionError(f"{detail} {_INSTALL_HINT}")


def _explicit_value(value: str | None, variable: str) -> str | None:
    return value if value is not None else environ.get(variable) or None


def _executable_sibling(command: str, sibling: str) -> str:
    resolved = shutil.which(command)
    if resolved:
        candidate = Path(resolved).absolute().parent / f"{sibling}{_exe_suffix()}"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise FFmpegPairResolutionError(
        f"{command!r} has no executable {sibling} sibling. Supply both explicit commands. "
        f"{_INSTALL_HINT}"
    )


def resolve_ffmpeg_pair(ffmpeg: str | None = None, ffprobe: str | None = None) -> FFmpegPair:
    """Admit a complete supported pair without mixing partial installations."""
    selected_ffmpeg = _explicit_value(ffmpeg, "PODCAST_MCP_FFMPEG")
    selected_ffprobe = _explicit_value(ffprobe, "PODCAST_MCP_FFPROBE")
    if selected_ffmpeg is not None or selected_ffprobe is not None:
        if selected_ffmpeg is None:
            selected_ffmpeg = _executable_sibling(selected_ffprobe or "", "ffmpeg")
        if selected_ffprobe is None:
            selected_ffprobe = _executable_sibling(selected_ffmpeg, "ffprobe")
        return _validate(selected_ffmpeg, selected_ffprobe, "explicit")
    if bundle := environ.get("PODCAST_MCP_FFMPEG_BUNDLE"):
        commands = _pair_in(Path(bundle))
        if commands is None:
            raise FFmpegPairResolutionError(
                f"Declared FFmpeg bundle {bundle!r} is incomplete or not executable. "
                "Reinstall Sharecut Studio or supply a supported explicit pair."
            )
        try:
            pair = _validate(*commands, "bundle")
            if pair.version != tuple(map(int, ffmpeg_policy()["version"].split("."))):
                raise FFmpegPairResolutionError("bundle must report the exact pinned release")
            return pair
        except FFmpegPairResolutionError as exc:
            raise FFmpegPairResolutionError(f"Invalid FFmpeg bundle {bundle!r}: {exc}") from exc
    return _automatic_pair()


def resolve_ffmpeg() -> str:
    """Return FFmpeg from the validated pair."""
    return resolve_ffmpeg_pair().ffmpeg


def resolve_ffprobe() -> str:
    """Return FFprobe from the validated pair."""
    return resolve_ffmpeg_pair().ffprobe
