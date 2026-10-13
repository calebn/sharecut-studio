"""The refusal for a share registry path whose privacy or identity cannot be trusted.

``util/registry_backup_posix.py`` and ``util/registry_backup_windows.py`` raise it at the
boundary, where the offending path is known. It never carries an account identifier (a SID).
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
from pathlib import Path, PureWindowsPath

from podcast_mcp.util.coded_error import HostSetupError

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
    REPARSE_POINT = "reparse_point"
    NOT_LOCAL_NTFS = "not_local_ntfs"
    NOT_A_FOLDER = "not_a_folder"
    WINDOWS_ACL = "windows_acl"
    PARENT_ACL = "parent_acl"
    PATH_CHANGED = "path_changed"
    AMBIGUOUS_ANCHOR = "ambiguous_anchor"
    INVALID_BACKUP_NAME = "invalid_backup_name"
    DIRECTORY_CHANGED = "directory_changed"
    REGISTRY_FILE_CHANGED = "registry_file_changed"
    BACKUP_FILE_CHANGED = "backup_file_changed"
    SNAPSHOT_CHANGED = "snapshot_changed"
    CLEANUP_FILE_SUBSTITUTED = "cleanup_file_substituted"
    CLEANUP_WORKSPACE_SUBSTITUTED = "cleanup_workspace_substituted"


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
    RegistryPrivacyReason.REPARSE_POINT: "registry path {path} is a junction or other reparse point, which is never followed",
    RegistryPrivacyReason.NOT_LOCAL_NTFS: "registry path {path} is not on a local NTFS drive",
    RegistryPrivacyReason.NOT_A_FOLDER: "registry folder {path} is not a folder",
    RegistryPrivacyReason.WINDOWS_ACL: "registry path {path} has permissions that are not limited to your account, SYSTEM and Administrators",
    RegistryPrivacyReason.PARENT_ACL: "folder {path} above the registry can be changed by another account",
    RegistryPrivacyReason.PATH_CHANGED: "registry path {path} was replaced while it was being checked",
    RegistryPrivacyReason.AMBIGUOUS_ANCHOR: "registry path {path} has an ambiguous Windows anchor",
    RegistryPrivacyReason.INVALID_BACKUP_NAME: "backup path {path} does not denote an unambiguous Windows regular file",
    RegistryPrivacyReason.DIRECTORY_CHANGED: "registry directory {path} changed during access",
    RegistryPrivacyReason.REGISTRY_FILE_CHANGED: "registry file {path} changed during access",
    RegistryPrivacyReason.BACKUP_FILE_CHANGED: "backup file {path} changed identity or regular-file type",
    RegistryPrivacyReason.SNAPSHOT_CHANGED: "backup snapshot {path} changed before streaming",
    RegistryPrivacyReason.CLEANUP_FILE_SUBSTITUTED: "cleanup refused substituted backup file {path}",
    RegistryPrivacyReason.CLEANUP_WORKSPACE_SUBSTITUTED: "cleanup refused substituted backup workspace {path}",
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
    RegistryPrivacyReason.REPARSE_POINT: "replace it with the real folder, or " + _PIN,
    RegistryPrivacyReason.NOT_LOCAL_NTFS: "move the registry to a local NTFS drive (not a network share or alternate stream), or "
    + _PIN,
    RegistryPrivacyReason.NOT_A_FOLDER: "move it aside, or " + _PIN,
    RegistryPrivacyReason.WINDOWS_ACL: "in its Security settings, remove other accounts and reset it to your account, SYSTEM and Administrators only",
    RegistryPrivacyReason.PARENT_ACL: "move the registry under a folder you own, or " + _PIN,
    RegistryPrivacyReason.PATH_CHANGED: "try again, and if it keeps happening, find what is replacing it, or "
    + _PIN,
    RegistryPrivacyReason.AMBIGUOUS_ANCHOR: "choose a fully anchored local Windows path or an ordinary relative path",
    RegistryPrivacyReason.INVALID_BACKUP_NAME: "choose a plain filename without reserved devices, streams, forbidden characters, trailing dot or space",
    RegistryPrivacyReason.DIRECTORY_CHANGED: "stop processes replacing this directory, then retry",
    RegistryPrivacyReason.REGISTRY_FILE_CHANGED: "stop processes replacing this registry file, then retry",
    RegistryPrivacyReason.BACKUP_FILE_CHANGED: "stop processes replacing this backup file, then retry",
    RegistryPrivacyReason.SNAPSHOT_CHANGED: "stop processes replacing this snapshot, then retry the backup",
    RegistryPrivacyReason.CLEANUP_FILE_SUBSTITUTED: "inspect the retained file and stop replacements before retrying",
    RegistryPrivacyReason.CLEANUP_WORKSPACE_SUBSTITUTED: "inspect the retained workspace and stop replacements before retrying",
}

_CODE = {
    RegistryPrivacyReason.AMBIGUOUS_ANCHOR: "registry_backup_invalid_path",
    RegistryPrivacyReason.INVALID_BACKUP_NAME: "registry_backup_invalid_path",
    RegistryPrivacyReason.DIRECTORY_CHANGED: "registry_backup_integrity_changed",
    RegistryPrivacyReason.REGISTRY_FILE_CHANGED: "registry_backup_integrity_changed",
    RegistryPrivacyReason.BACKUP_FILE_CHANGED: "registry_backup_integrity_changed",
    RegistryPrivacyReason.SNAPSHOT_CHANGED: "registry_backup_integrity_changed",
    RegistryPrivacyReason.CLEANUP_FILE_SUBSTITUTED: "registry_backup_integrity_changed",
    RegistryPrivacyReason.CLEANUP_WORKSPACE_SUBSTITUTED: "registry_backup_integrity_changed",
}


class RegistryPrivacyError(HostSetupError):
    """A registry path is not private or its trusted identity changed."""

    code = REGISTRY_NOT_PRIVATE_CODE

    def __init__(
        self,
        path: Path | PureWindowsPath,
        reason: RegistryPrivacyReason,
        *,
        mode: int | None = None,
    ) -> None:
        shown = f'"{path}"' if isinstance(path, PureWindowsPath) else shlex.quote(str(path))
        fields = {
            "path": shown,
            "mode": f"{stat.S_IMODE(mode):04o}" if mode is not None else "unknown",
        }
        self.path = path
        self.reason = reason
        self.fix = _FIX[reason].format(**fields)
        super().__init__(
            f"{_PROBLEM[reason].format(**fields)}; {self.fix}",
            code=_CODE.get(reason, REGISTRY_NOT_PRIVATE_CODE),
            guest_message=GUEST_MESSAGE,
        )
