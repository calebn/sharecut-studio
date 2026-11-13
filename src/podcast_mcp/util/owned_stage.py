"""Descriptor-owned temporary directory with no-replace publication.

Quarantine is private to the owner. This does not protect path-based external
writers against an arbitrary actor with the same operating-system identity.
"""

from __future__ import annotations

import errno
import os
import shutil
import stat
from contextlib import ExitStack, suppress
from pathlib import Path
from uuid import uuid4

from podcast_mcp.util import host_platform
from podcast_mcp.util.atomic_directory import rename_noreplace
from podcast_mcp.util.pinned_media import descriptor_walk_supported, open_nofollow_dir


def owned_stage_supported() -> bool:
    return (
        host_platform.current().kernel in ("linux", "darwin")
        and descriptor_walk_supported()
        and os.stat in os.supports_dir_fd
        and os.mkdir in os.supports_dir_fd
        and os.rename in os.supports_dir_fd
        and os.rmdir in os.supports_dir_fd
        and shutil.rmtree.avoids_symlink_attacks
    )


def _identity(value: os.stat_result) -> tuple[int, int]:
    if not stat.S_ISDIR(value.st_mode):
        raise OSError(errno.ENOTDIR, "stage mapping is not a directory")
    return value.st_dev, value.st_ino


def _open_root(path: Path) -> int:
    descriptor = open_nofollow_dir(path.anchor)
    resources = ExitStack()
    resources.callback(_close_descriptor, descriptor)
    try:
        for part in path.parts[1:]:
            child = open_nofollow_dir(part, dir_fd=descriptor)
            child_resources = ExitStack()
            child_resources.callback(_close_descriptor, child)
            previous_resources = resources
            resources = child_resources.pop_all()
            previous_resources.close()
            descriptor = child
        resources.pop_all()
        return descriptor
    except BaseException:
        resources.close()
        raise


def _close_descriptor(descriptor: int) -> None:
    with suppress(OSError):
        os.close(descriptor)


class OwnedStage:
    def __init__(self, root: Path) -> None:
        if not owned_stage_supported():
            raise OSError(errno.ENOTSUP, "safe staging requires directory descriptors")
        self.root = root
        self.name = f".partial-{uuid4().hex}"
        self.path = root / self.name
        self.committed = False
        with ExitStack() as resources:
            self.root_fd = _open_root(root)
            resources.callback(_close_descriptor, self.root_fd)
            self.root_identity = _identity(os.fstat(self.root_fd))
            os.mkdir(self.name, mode=0o700, dir_fd=self.root_fd)
            self.stage_fd = open_nofollow_dir(self.name, dir_fd=self.root_fd)
            resources.callback(_close_descriptor, self.stage_fd)
            self.stage_identity = _identity(os.fstat(self.stage_fd))
            self._resources = resources.pop_all()

    def verify(self, name: str | None = None) -> None:
        visible = _open_root(self.root)
        try:
            if _identity(os.fstat(visible)) != self.root_identity:
                raise OSError(errno.ESTALE, "stage parent changed")
            if (
                _identity(os.stat(name or self.name, dir_fd=visible, follow_symlinks=False))
                != self.stage_identity
            ):
                raise OSError(errno.ESTALE, "stage directory changed")
        finally:
            os.close(visible)

    def publish(self, name: str) -> None:
        self.verify()
        os.fsync(self.stage_fd)
        rename_noreplace(self.name, name, self.root_fd)
        self.committed = True
        self.verify(name)
        os.fsync(self.root_fd)

    def close(self) -> None:
        try:
            if not self.committed:
                with suppress(OSError):
                    self._quarantine_cleanup()
        finally:
            self._resources.close()

    def _quarantine_cleanup(self) -> None:
        quarantine = f".cleanup-{uuid4().hex}"
        os.mkdir(quarantine, mode=0o700, dir_fd=self.root_fd)
        identity: tuple[int, int] | None = None
        try:
            with ExitStack() as resources:
                quarantine_fd = open_nofollow_dir(quarantine, dir_fd=self.root_fd)
                resources.callback(_close_descriptor, quarantine_fd)
                identity = _identity(os.fstat(quarantine_fd))
                rename_noreplace(self.name, "stage", self.root_fd, dst_root_fd=quarantine_fd)
                moved = _identity(os.stat("stage", dir_fd=quarantine_fd, follow_symlinks=False))
                if moved != self.stage_identity:
                    with suppress(OSError):
                        rename_noreplace(
                            "stage", self.name, quarantine_fd, dst_root_fd=self.root_fd
                        )
                    return
                shutil.rmtree("stage", dir_fd=quarantine_fd)
        finally:
            if identity is not None:
                self._remove_quarantine_if_owned(quarantine, identity)

    def _remove_quarantine_if_owned(self, quarantine: str, identity: tuple[int, int]) -> None:
        with suppress(OSError):
            if (
                _identity(os.stat(quarantine, dir_fd=self.root_fd, follow_symlinks=False))
                == identity
            ):
                os.rmdir(quarantine, dir_fd=self.root_fd)
