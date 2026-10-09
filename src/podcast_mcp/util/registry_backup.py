from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath

from podcast_mcp.util.registry_backup_posix import BackupDirectory as PosixDirectory
from podcast_mcp.util.registry_backup_windows import BackupDirectory as WindowsDirectory
from podcast_mcp.util.registry_backup_windows import _validate_name as _validate_windows_name
from podcast_mcp.util.registry_cleanup import cleanup as _cleanup
from podcast_mcp.util.sqlite_tx import SQLITE_SIDECARS

_COPY_BUFFER_BYTES = 1024 * 1024
_SQLITE_SIDECARS = SQLITE_SIDECARS


def _anchor_path(path: str | os.PathLike[str]) -> Path:
    raw = os.fspath(path)
    if os.name == "nt":
        windows_path = PureWindowsPath(raw)
        if bool(windows_path.drive) != bool(windows_path.root):
            raise PermissionError("registry paths must use an unambiguous Windows anchor")
        for component in windows_path.parts[1:] if windows_path.anchor else windows_path.parts:
            _validate_windows_name(component)
    requested = Path(raw)
    return requested if requested.is_absolute() else Path.cwd() / requested


def _directory(path: Path) -> PosixDirectory | WindowsDirectory:
    return WindowsDirectory(path) if os.name == "nt" else PosixDirectory(path)


@contextmanager
def _closing_directory(path: Path) -> Iterator[PosixDirectory | WindowsDirectory]:
    directory = _directory(path)
    try:
        yield directory
    finally:
        _cleanup([directory.close])


def _require_unused(directory: PosixDirectory | WindowsDirectory, name: str) -> None:
    if any(directory.exists(name + suffix) for suffix in ("", *_SQLITE_SIDECARS)):
        raise FileExistsError("backup destination and its SQLite sidecar names must be unused")


def _copy_snapshot(source_fd: int, destination_fd: int) -> None:
    while block := os.read(source_fd, _COPY_BUFFER_BYTES):
        remaining = memoryview(block)
        while remaining:
            written = os.write(destination_fd, remaining)
            if written <= 0:
                raise OSError("registry backup stream could not be written")
            remaining = remaining[written:]


def publish_registry_backup(
    source: Path, destination: Path, snapshot: Callable[[Path], None]
) -> Path:
    """Create a private SQLite disk snapshot, then publish bytes at a new trusted name.

    SQLite only opens the snapshot inside the validated host-side private workspace.
    Publication is no-replace on the destination volume, independent of source volume.
    A post-publication durability error never removes the completed backup.
    """
    source = _anchor_path(source)
    destination = _anchor_path(destination)
    if any(destination == Path(str(source) + suffix) for suffix in ("", *_SQLITE_SIDECARS)):
        raise FileExistsError("backup destination must be outside the live registry namespace")
    with _closing_directory(destination.parent) as output:
        _require_unused(output, destination.name)
        with _closing_directory(source.parent) as host:
            workspace_name = f".registry-snapshot-{uuid.uuid4().hex}"
            with host.workspace(workspace_name) as private:
                snapshot_name = "registry.sqlite"
                with private.created_file(snapshot_name) as disk_snapshot:
                    disk_snapshot.close_descriptor()
                    snapshot(disk_snapshot.path)
                    private.verify_file(snapshot_name, disk_snapshot.identity)
                    if any(private.exists(snapshot_name + suffix) for suffix in _SQLITE_SIDECARS):
                        raise OSError("registry snapshot still depends on SQLite sidecars")
                    output.verify()
                    _require_unused(output, destination.name)
                    with private.snapshot_reader(snapshot_name, disk_snapshot.identity) as read_fd:
                        stage_name = f".{destination.name}.{uuid.uuid4().hex}.partial"
                        with output.created_file(stage_name) as stage:
                            _copy_snapshot(read_fd, stage.fd)
                            os.fsync(stage.fd)
                            output.verify_file(stage_name, stage.identity)
                            _require_unused(output, destination.name)
                            output.publish(stage_name, destination.name, stage.identity, stage.fd)
                            try:
                                output.verify_file(destination.name, stage.identity)
                                output.check_published_directory()
                            except OSError as exc:
                                raise OSError(
                                    "registry backup was published, but directory durability could not be confirmed"
                                ) from exc
    return destination
