"""The refusal for a share registry path that is not private to the host user.

``util/registry_backup_posix.py`` raises it at the boundary, where the offending path is known.
Every adapter already reports a ``CodedError``'s message and code (``util/coded_error.py``), so
the CLI prints one ``Error:`` line, an MCP tool returns it as a structured refusal, and the GUI
maps it in ``gui/routes/deps.py``. A share guest never gets that message: the error holds a
second, fixed ``GUEST_MESSAGE`` with no path and no command, and every guest or relayed
adapter reads it through ``util/tool_refusal.py``.

The refusal is fail-closed: it names what is wrong and how to fix it, and never repairs anything.
A fix is a command only when running it on a path the host owns cannot widen access.
"""

from __future__ import annotations

import shlex
import stat
from enum import StrEnum
from pathlib import Path

from podcast_mcp.util.coded_error import CodedPermissionError

REGISTRY_NOT_PRIVATE_CODE = "registry_not_private"
GUEST_MESSAGE = "The host's sharing setup needs attention; ask the host to check it."
_PIN = "set PODCAST_SHARE_REGISTRY to a registry you own"


class RegistryPrivacyReason(StrEnum):
    FILE_MODE = "file_mode"
    FILE_OWNER = "file_owner"
    FILE_NOT_REGULAR = "file_not_regular"
    DIRECTORY_MODE = "directory_mode"
    DIRECTORY_OWNER = "directory_owner"
    ACL = "acl"
    SYMLINK = "symlink"
    PARENT_WRITABLE = "parent_writable"
    PARENT_WRITABLE_NOT_MINE = "parent_writable_not_mine"
    PARENT_OWNER = "parent_owner"


_PROBLEM = {
    RegistryPrivacyReason.FILE_MODE: "registry file {path} must be owned and private (0600) but is mode {mode}",
    RegistryPrivacyReason.FILE_OWNER: "registry file {path} is owned by another user",
    RegistryPrivacyReason.FILE_NOT_REGULAR: "registry file {path} is not a regular file",
    RegistryPrivacyReason.DIRECTORY_MODE: "registry folder {path} must be owned and private (0700) but is mode {mode}",
    RegistryPrivacyReason.DIRECTORY_OWNER: "registry folder {path} is owned by another user",
    RegistryPrivacyReason.ACL: "registry path {path} has an extended ACL that grants other accounts access",
    RegistryPrivacyReason.SYMLINK: "registry path {path} is a symbolic link, which is never followed",
    RegistryPrivacyReason.PARENT_WRITABLE: "folder {path} above the registry lets other users replace entries",
    RegistryPrivacyReason.PARENT_WRITABLE_NOT_MINE: "folder {path} above the registry lets other users replace entries",
    RegistryPrivacyReason.PARENT_OWNER: "folder {path} above the registry is owned by another user",
}

_FIX = {
    RegistryPrivacyReason.FILE_MODE: "run: chmod 0600 {path}",
    RegistryPrivacyReason.FILE_OWNER: "restore your ownership of it, or " + _PIN,
    RegistryPrivacyReason.FILE_NOT_REGULAR: "move it aside, or " + _PIN,
    RegistryPrivacyReason.DIRECTORY_MODE: "run: chmod 0700 {path}",
    RegistryPrivacyReason.DIRECTORY_OWNER: "restore your ownership of it, or " + _PIN,
    RegistryPrivacyReason.ACL: "remove the extra access entries so only you have access",
    RegistryPrivacyReason.SYMLINK: "replace it with the real folder or file, or " + _PIN,
    RegistryPrivacyReason.PARENT_WRITABLE: "run: chmod go-w {path}",
    RegistryPrivacyReason.PARENT_WRITABLE_NOT_MINE: "ask its owner to remove write access for others, or "
    + _PIN,
    RegistryPrivacyReason.PARENT_OWNER: "move the registry under a folder you own, or " + _PIN,
}


class RegistryPrivacyError(CodedPermissionError):
    """A registry file, folder or ancestor is not private to the host user."""

    code = REGISTRY_NOT_PRIVATE_CODE

    def __init__(
        self, path: Path, reason: RegistryPrivacyReason, *, mode: int | None = None
    ) -> None:
        shown = shlex.quote(str(path))
        fields = {
            "path": shown,
            "mode": f"{stat.S_IMODE(mode):04o}" if mode is not None else "unknown",
        }
        self.path = path
        self.reason = reason
        self.fix = _FIX[reason].format(**fields)
        super().__init__(
            f"{_PROBLEM[reason].format(**fields)}; {self.fix}", guest_message=GUEST_MESSAGE
        )
