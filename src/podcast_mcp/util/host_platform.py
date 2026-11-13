"""What this host can do. The one place the engine asks which platform it runs on.

A site that needs a platform fact reads a field of ``current()``; it never reads
``sys.platform``, ``platform`` or ``os.name`` itself (Ruff bans them outside this module).
A new host is one more row.

Two axes, because the checks ask two different questions:

- ``kernel`` decides syscalls. macOS and iOS share the Darwin kernel, so ``renameatx_np``,
  ``fclonefileat`` and the ACL calls take one branch for both.
- The capability fields decide features: whether processes can be spawned, which dialog,
  reveal and player tools exist, whether media tools and transcription exist, and whether a
  loopback peer is trusted.

Pure: nothing here imports from ``podcast_mcp``, so ``settings`` can import it.
"""

from __future__ import annotations

import os
import platform
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

Kernel = Literal["darwin", "linux", "nt", "other"]
MediaTools = Literal["executables", "unavailable"]
Transcription = Literal["faster_whisper", "unavailable"]
FileDialog = Literal["osascript", "powershell", "zenity"]
RevealTool = Literal["open", "explorer", "xdg-open"]
AuditionPlayer = Literal["afplay", "ffplay"]

MEDIA_UNAVAILABLE = "ShareCut can't process audio on this device yet."
TRANSCRIPTION_UNAVAILABLE = "ShareCut can't transcribe audio on this device yet."


@dataclass(frozen=True)
class DataRoots:
    """Where this host keeps ShareCut data when no ``PODCAST_*`` override names a place."""

    config: Path
    cache: Path
    state: Path
    workspace: Path
    exports: Path
    log_dirs: tuple[Path, ...]
    # The directory whose ancestors belong to the OS. The private-directory ancestor walk stops
    # here. None walks to the filesystem root.
    trust_root: Path | None


@dataclass(frozen=True)
class HostPlatform:
    name: str
    kernel: Kernel
    # Exactly what ``platform.system()`` returned for this host before the table existed.
    system_label: str
    can_spawn_processes: bool
    loopback_is_trusted: bool
    media_tools: MediaTools
    transcription: Transcription
    file_dialog: FileDialog | None
    reveal_tool: RevealTool | None
    audition_player: AuditionPlayer | None
    homebrew_ffmpeg: bool
    executable_suffix: str
    # HOME is the app container and data follows Apple's Library and Documents layout.
    app_container: bool = False

    @property
    def is_nt(self) -> bool:
        return self.kernel == "nt"

    @property
    def is_posix(self) -> bool:
        return self.kernel != "nt"

    def data_roots(self, home: Path) -> DataRoots:
        if self.app_container:
            support = home / "Library" / "Application Support" / "ShareCut"
            return DataRoots(
                config=support,
                cache=home / "Library" / "Caches" / "ShareCut",
                state=support / "state",
                workspace=home / "Documents",
                exports=home / "Documents" / "Exports",
                log_dirs=(home / "Library" / "Logs" / "ShareCut",),
                trust_root=home,
            )
        return DataRoots(
            config=home / ".config" / "podcast_mcp",
            cache=home / ".cache" / "podcast_mcp",
            state=home / ".podcast_mcp",
            workspace=home / "ShareCut",
            exports=home / "Downloads",
            log_dirs=(
                home / "Library" / "Logs" / "ShareCut Studio",
                home / ".local" / "state" / "SharecutStudio",
            ),
            trust_root=None,
        )


MACOS = HostPlatform(
    name="macos",
    kernel="darwin",
    system_label="Darwin",
    can_spawn_processes=True,
    loopback_is_trusted=True,
    media_tools="executables",
    transcription="faster_whisper",
    file_dialog="osascript",
    reveal_tool="open",
    audition_player="afplay",
    homebrew_ffmpeg=True,
    executable_suffix="",
)
LINUX = HostPlatform(
    name="linux",
    kernel="linux",
    system_label="Linux",
    can_spawn_processes=True,
    loopback_is_trusted=True,
    media_tools="executables",
    transcription="faster_whisper",
    file_dialog="zenity",
    reveal_tool="xdg-open",
    audition_player="ffplay",
    homebrew_ffmpeg=False,
    executable_suffix="",
)
WINDOWS = HostPlatform(
    name="windows",
    kernel="nt",
    system_label="Windows",
    can_spawn_processes=True,
    loopback_is_trusted=True,
    media_tools="executables",
    transcription="faster_whisper",
    file_dialog="powershell",
    reveal_tool="explorer",
    audition_player="ffplay",
    homebrew_ffmpeg=False,
    executable_suffix=".exe",
)
IOS = HostPlatform(
    name="ios",
    kernel="darwin",
    system_label="iOS",
    can_spawn_processes=False,
    loopback_is_trusted=False,
    media_tools="unavailable",
    transcription="unavailable",
    file_dialog=None,
    reveal_tool=None,
    audition_player=None,
    homebrew_ffmpeg=False,
    executable_suffix="",
    app_container=True,
)
GENERIC_POSIX = HostPlatform(
    name="posix",
    kernel="other",
    system_label="",
    can_spawn_processes=True,
    loopback_is_trusted=True,
    media_tools="executables",
    transcription="faster_whisper",
    file_dialog=None,
    reveal_tool=None,
    audition_player="ffplay",
    homebrew_ffmpeg=False,
    executable_suffix="",
)
GENERIC_NT = replace(GENERIC_POSIX, name="nt", kernel="nt", executable_suffix=".exe")

ROWS: tuple[HostPlatform, ...] = (MACOS, LINUX, WINDOWS, IOS, GENERIC_POSIX, GENERIC_NT)

_override: HostPlatform | None = None


def current() -> HostPlatform:
    """The row for this process. An unlisted platform gets a generic row; this never raises."""
    if _override is not None:
        return _override
    name = sys.platform
    if name == "darwin":
        return MACOS
    if name.startswith("linux"):
        return LINUX
    if name == "win32":
        return WINDOWS
    if name == "ios":
        return IOS
    generic = GENERIC_NT if os.name == "nt" else GENERIC_POSIX
    return replace(generic, system_label=platform.system())


@contextmanager
def using(row: HostPlatform) -> Iterator[HostPlatform]:
    """Make ``current()`` return ``row`` inside the block. Tests select a row with this."""
    global _override
    previous = _override
    _override = row
    try:
        yield row
    finally:
        _override = previous


def data_roots() -> DataRoots:
    """The default data locations for this host and this user's home."""
    return current().data_roots(Path.home())


def machine() -> str:
    """The CPU architecture, as reported data and for the Homebrew prefix."""
    return platform.machine()


def release() -> str:
    """The OS release string, as reported data."""
    return platform.release()
