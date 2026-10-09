from __future__ import annotations

import os
import sys
import uuid
from collections.abc import Callable
from contextlib import closing
from functools import partial
from pathlib import Path

from podcast_mcp.util.registry_backup_posix import BackupDirectory as PosixDirectory
from podcast_mcp.util.registry_backup_posix import identity
from podcast_mcp.util.registry_backup_windows import BackupDirectory as WindowsDirectory

_COPY_BUFFER_BYTES = 1024 * 1024
_SQLITE_SIDECARS = ("-wal", "-shm", "-journal")


def _directory(path: Path) -> PosixDirectory | WindowsDirectory:
    return WindowsDirectory(path) if os.name == "nt" else PosixDirectory(path)


def _cleanup(actions: list[Callable[[], None]]) -> None:
    original = sys.exc_info()[1]
    first: BaseException | None = None
    for action in actions:
        try:
            action()
        except BaseException as exc:
            if original is not None:
                original.add_note(
                    "Registry backup cleanup could not remove an owned temporary entry."
                )
            elif first is None:
                first = exc
    if first is not None:
        raise first


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
    source = Path(os.path.abspath(source))
    destination = Path(os.path.abspath(destination))
    if any(destination == Path(str(source) + suffix) for suffix in ("", *_SQLITE_SIDECARS)):
        raise FileExistsError("backup destination must be outside the live registry namespace")
    with closing(_directory(destination.parent)) as output:
        _require_unused(output, destination.name)
        with closing(_directory(source.parent)) as host:
            workspace_name = f".registry-snapshot-{uuid.uuid4().hex}"
            workspace_identity = host.create_workspace(workspace_name)
            try:
                with closing(_directory(host.path / workspace_name)) as private:
                    snapshot_name = "registry.sqlite"
                    snapshot_fd = private.create_file(snapshot_name)
                    snapshot_identity = identity(os.fstat(snapshot_fd))
                    os.close(snapshot_fd)
                    stage_name = f".{destination.name}.{uuid.uuid4().hex}.partial"
                    stage_identity = None
                    stage_fd = None
                    read_fd = None
                    try:
                        snapshot(private.path / snapshot_name)
                        private.verify_file(snapshot_name, snapshot_identity)
                        if any(
                            private.exists(snapshot_name + suffix) for suffix in _SQLITE_SIDECARS
                        ):
                            raise OSError("registry snapshot still depends on SQLite sidecars")
                        output.verify()
                        _require_unused(output, destination.name)
                        read_fd = private.open_snapshot(snapshot_name, snapshot_identity)
                        stage_fd = output.create_file(stage_name)
                        stage_identity = identity(os.fstat(stage_fd))
                        _copy_snapshot(read_fd, stage_fd)
                        os.fsync(stage_fd)
                        output.verify_file(stage_name, stage_identity)
                        _require_unused(output, destination.name)
                        output.publish(stage_name, destination.name, stage_identity, stage_fd)
                        try:
                            output.verify_file(destination.name, stage_identity)
                            output.sync()
                        except OSError as exc:
                            raise OSError(
                                "registry backup was published, but directory durability could not be confirmed"
                            ) from exc
                    finally:
                        actions: list[Callable[[], None]] = []
                        if read_fd is not None:
                            actions.append(partial(os.close, read_fd))
                        if stage_fd is not None:
                            actions.append(partial(os.close, stage_fd))
                        if stage_identity is not None:
                            actions.append(partial(output.remove_file, stage_name, stage_identity))
                        actions.append(
                            lambda: private.remove_file(snapshot_name, snapshot_identity)
                        )
                        _cleanup(actions)
            finally:
                _cleanup([lambda: host.remove_workspace(workspace_name, workspace_identity)])
    return destination
