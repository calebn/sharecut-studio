"""What this host can do. The one place the engine asks which platform it runs on.

A site that needs a platform fact reads a field of ``current()``; it never reads
``sys.platform``, ``platform`` or ``os.name`` itself (Ruff bans them outside this module).
A new host is one more row.

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
# A platform that is neither listed nor a desktop kernel family (android, wasi, emscripten, a
# name not yet known) may be a sandbox, so it starts with no capability and no trust.
UNKNOWN = HostPlatform(
    name="unknown",
    kernel="other",
    system_label="",
    can_spawn_processes=False,
    loopback_is_trusted=False,
    media_tools="unavailable",
    transcription="unavailable",
    file_dialog=None,
    reveal_tool=None,
    audition_player=None,
    homebrew_ffmpeg=False,
    executable_suffix="",
)

ROWS: tuple[HostPlatform, ...] = (MACOS, LINUX, WINDOWS, IOS, GENERIC_POSIX, GENERIC_NT, UNKNOWN)

# ``sys.platform`` prefixes of the desktop kernels that ran ShareCut through the generic rows
# before the table existed. Only these get GENERIC_POSIX / GENERIC_NT; any other name is UNKNOWN.
DESKTOP_KERNEL_FAMILIES: tuple[str, ...] = (
    "freebsd",
    "openbsd",
    "netbsd",
    "dragonfly",
    "sunos",
    "aix",
    "cygwin",
    "msys",
)

_override: HostPlatform | None = None
_syscalls_mocked = False


class ForeignKernelError(RuntimeError):
    """A test selected a row whose kernel is not this machine's and reached that kernel's syscall."""


def _detect() -> HostPlatform:
    name = sys.platform
    if name == "darwin":
        return MACOS
    if name.startswith("linux"):
        return LINUX
    if name == "win32":
        return WINDOWS
    if name == "ios":
        return IOS
    if name.startswith(DESKTOP_KERNEL_FAMILIES):
        generic = GENERIC_NT if os.name == "nt" else GENERIC_POSIX
    else:
        generic = UNKNOWN
    return replace(generic, system_label=platform.system())


def current() -> HostPlatform:
    """The row for this process. An unlisted platform is a desktop family's generic row or the
    fail-closed UNKNOWN row; this never raises."""
    return _override if _override is not None else _detect()


def syscall_kernel() -> Kernel:
    """The kernel whose syscall, libc symbol or ``/proc`` file the caller is about to use.

    A site that branches on the kernel to call ``ctypes``, ``fcntl``, ``os.listxattr``, ``/proc``
    or a kernel-specific tool reads it here, never from ``current().kernel``. Production never
    overrides the row, so this is ``current().kernel``. Under ``using(row)`` a row whose kernel
    differs from the machine's would reach a symbol that is absent on this OS, and which OS
    notices differs, so it raises on every OS. The ``other`` kernel has no syscall branch.
    """
    row = current()
    if _override is None or _syscalls_mocked or row.kernel == "other":
        return row.kernel
    real = _detect()
    if row.kernel != real.kernel:
        raise ForeignKernelError(
            f"a test selected the {row.name} row and reached a {row.kernel} syscall on a "
            f"{real.name} machine; build the row with dataclasses.replace(current(), ...), or "
            "pass real_syscalls=False to using() when the test replaces the syscall layer"
        )
    return row.kernel


@contextmanager
def using(row: HostPlatform, *, real_syscalls: bool = True) -> Iterator[HostPlatform]:
    """Make ``current()`` return ``row`` inside the block. Tests select a row with this.

    ``real_syscalls=False`` says the test replaces the syscall layer, so a row of another kernel
    may reach ``syscall_kernel()``.
    """
    global _override, _syscalls_mocked
    previous = _override, _syscalls_mocked
    _override, _syscalls_mocked = row, not real_syscalls
    try:
        yield row
    finally:
        _override, _syscalls_mocked = previous


def data_roots() -> DataRoots:
    return current().data_roots(Path.home())


def container_root() -> Path | None:
    """The app container this process lives in, or None on a host whose paths never move."""
    return Path.home().resolve() if current().app_container else None


def to_stored(absolute: str) -> str:
    """The form of an absolute path that survives the container moving.

    On a container host a path under the home is stored relative to it; any other path, and every
    path on a host whose paths never move, stays as written.
    """
    root = container_root()
    if root is None:
        return absolute
    try:
        return Path(absolute).relative_to(root).as_posix()
    except ValueError:
        return absolute


def from_stored(stored: str) -> str | None:
    """The absolute path a stored value names, or None for a value that must not be used.

    On a container host a stored path is relative to the home, so one that climbs out of it
    (a ``..`` segment, or a symlink that leaves it) is dropped, and so is an absolute path under
    the home, which is never written that way. An absolute path elsewhere is a folder the person
    picked outside the container and stays as written. A value with a NUL byte, and ``""`` or
    ``"."`` (which would name the home itself), fail closed on every host: a registry row is
    untrusted input and one bad row must not raise out of a sweep.
    """
    if "\x00" in stored or stored in {"", "."}:
        return None
    root = container_root()
    if root is None:
        return stored
    if os.path.isabs(stored):
        return None if Path(stored).is_relative_to(root) else stored
    if ".." in Path(stored).parts:
        return None
    joined = root / stored
    return str(joined) if joined.resolve().is_relative_to(root) else None


def machine() -> str:
    return platform.machine()


def release() -> str:
    return platform.release()
