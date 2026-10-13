"""Windows registry privacy checks refuse with a path and a fix, never a SID (#1310).

The native handle calls are replaced, so this runs on every platform; the real Windows run
is the ``native-registry-backup`` job.
"""

from __future__ import annotations

import ctypes
import pickle
from pathlib import PureWindowsPath
from types import SimpleNamespace
from typing import Any

import pytest

from podcast_mcp.util import registry_backup_windows as windows
from podcast_mcp.util.registry_privacy_error import (
    GUEST_MESSAGE,
    REGISTRY_NOT_PRIVATE_CODE,
    RegistryPrivacyError,
    RegistryPrivacyReason,
)

PATH = PureWindowsPath(r"C:\Users\Ada Lovelace\registry")
SHOWN = '"C:\\Users\\Ada Lovelace\\registry"'
OWNER_SID = "S-1-5-21-111-222-333-1001"
STRANGER_SID = "S-1-5-21-999-888-777-1002"
PIN = "set PODCAST_SHARE_REGISTRY to a registry you own"
NTFS_FIX = (
    f"move the registry to a local NTFS drive (not a network share or alternate stream), or {PIN}"
)
ACL_PROBLEM = (
    f"registry path {SHOWN} has permissions that are not limited to your account, "
    "SYSTEM and Administrators"
)
ACL_FIX = (
    "in its Security settings, remove other accounts and reset it to your account, "
    "SYSTEM and Administrators only"
)


def _api(
    *,
    attributes: int = 0x10,
    filesystem: str = "NTFS",
    index: int = 1,
    owner: str = OWNER_SID,
    acl: bool = True,
    ace_kind: int = 0,
    ace_sid: str = OWNER_SID,
) -> windows._WindowsAPI:
    api = object.__new__(windows._WindowsAPI)
    api.trusted = {OWNER_SID, "S-1-5-18", "S-1-5-32-544"}
    api.ancestry_trusted = api.trusted
    header = windows._AclHeader()
    header.count = 1
    ace = windows._AllowAce()
    ace.kind, ace.flags, ace.mask = ace_kind, 0, 1

    def information(handle: Any, pointer: Any) -> bool:
        info = ctypes.cast(pointer, ctypes.POINTER(windows._FileInformation)).contents
        info.attributes, info.index_low = attributes, index
        return True

    def volume(
        handle: Any,
        name: Any,
        length: Any,
        serial: Any,
        maximum: Any,
        flags: Any,
        buffer: Any,
        size: Any,
    ) -> bool:
        buffer.value = filesystem
        return True

    def security(
        handle: Any,
        kind: Any,
        requested: Any,
        output_owner: Any,
        group: Any,
        output_acl: Any,
        sacl: Any,
        descriptor: Any,
    ) -> int:
        ctypes.cast(output_owner, ctypes.POINTER(ctypes.c_void_p))[0] = 1
        if acl:
            ctypes.cast(output_acl, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(header)
        return 0

    def get_ace(_acl: Any, _index: Any, pointer: Any) -> bool:
        ctypes.cast(pointer, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(ace)
        return True

    api.kernel = SimpleNamespace(
        GetFileInformationByHandle=information,
        GetVolumeInformationByHandleW=volume,
        LocalFree=lambda descriptor: None,
    )
    api.security = SimpleNamespace(GetSecurityInfo=security, GetAce=get_ace)
    api.sid_string = lambda pointer: owner if getattr(pointer, "value", pointer) == 1 else ace_sid
    return api


def _refusal(api: windows._WindowsAPI, *, private: bool, directory: bool) -> RegistryPrivacyError:
    with pytest.raises(RegistryPrivacyError) as caught:
        api.verify_handle(7, private=private, directory=directory, path=PATH)
    return caught.value


@pytest.mark.parametrize(
    ("api_args", "private", "directory", "reason", "message"),
    [
        (
            {"attributes": 0x410},
            True,
            True,
            RegistryPrivacyReason.REPARSE_POINT,
            f"registry path {SHOWN} is a junction or other reparse point, which is never "
            f"followed; replace it with the real folder, or {PIN}",
        ),
        (
            {"attributes": 0x20},
            True,
            True,
            RegistryPrivacyReason.NOT_A_FOLDER,
            f"registry folder {SHOWN} is not a folder; move it aside, or {PIN}",
        ),
        (
            {"attributes": 0x10},
            True,
            False,
            RegistryPrivacyReason.FILE_NOT_REGULAR,
            f"registry file {SHOWN} is not a regular file; move it aside, or {PIN}",
        ),
        (
            {"filesystem": "ReFS"},
            True,
            True,
            RegistryPrivacyReason.NOT_LOCAL_NTFS,
            f"registry path {SHOWN} is not on a local NTFS drive; {NTFS_FIX}",
        ),
        (
            {"index": 0},
            True,
            True,
            RegistryPrivacyReason.NOT_LOCAL_NTFS,
            f"registry path {SHOWN} is not on a local NTFS drive; {NTFS_FIX}",
        ),
        (
            {"acl": False},
            True,
            True,
            RegistryPrivacyReason.WINDOWS_ACL,
            f"{ACL_PROBLEM}; {ACL_FIX}",
        ),
        (
            {"ace_sid": STRANGER_SID},
            True,
            True,
            RegistryPrivacyReason.WINDOWS_ACL,
            f"{ACL_PROBLEM}; {ACL_FIX}",
        ),
        (
            {"ace_kind": 5},
            True,
            True,
            RegistryPrivacyReason.WINDOWS_ACL,
            f"{ACL_PROBLEM}; {ACL_FIX}",
        ),
        (
            {"owner": STRANGER_SID, "attributes": 0},
            True,
            False,
            RegistryPrivacyReason.FILE_OWNER,
            f"registry file {SHOWN} is owned by another user; restore your ownership of it, "
            f"or {PIN}",
        ),
        (
            {"owner": STRANGER_SID},
            True,
            True,
            RegistryPrivacyReason.DIRECTORY_OWNER,
            f"registry folder {SHOWN} is owned by another user; restore your ownership of it, "
            f"or {PIN}",
        ),
        (
            {"owner": STRANGER_SID},
            False,
            True,
            RegistryPrivacyReason.PARENT_OWNER,
            f"folder {SHOWN} above the registry is owned by another user; move the registry "
            f"under a folder you own, or {PIN}",
        ),
    ],
)
def test_windows_check_refuses_with_path_reason_and_fix(
    api_args, private, directory, reason, message
):
    refusal = _refusal(_api(**api_args), private=private, directory=directory)
    assert refusal.reason is reason
    assert str(refusal) == message
    assert refusal.code == REGISTRY_NOT_PRIVATE_CODE
    assert refusal.guest_message() == GUEST_MESSAGE
    assert isinstance(refusal, PermissionError)


def test_no_refusal_names_an_account_identifier():
    refusals = [
        _refusal(_api(owner=STRANGER_SID), private=True, directory=True),
        _refusal(_api(ace_sid=STRANGER_SID), private=True, directory=True),
        _refusal(_api(ace_kind=5), private=True, directory=True),
    ]
    for refusal in refusals:
        assert "S-1-" not in str(refusal)
        assert "S-1-" not in refusal.guest_message()


def test_a_trusted_private_directory_is_admitted():
    assert _api().verify_handle(7, private=True, directory=True, path=PATH).index_low == 1


def test_a_replaced_directory_names_the_replaced_path():
    api = _api()
    api.open_directory = lambda part: 9
    with pytest.raises(RegistryPrivacyError) as caught:
        windows._verify_chain(api, PATH, [(PATH, 7, (1, 0, 2))])
    assert caught.value.reason is RegistryPrivacyReason.PATH_CHANGED
    assert str(caught.value) == (
        f"registry path {SHOWN} was replaced while it was being checked; try again, and if it "
        f"keeps happening, find what is replacing it, or {PIN}"
    )


@pytest.mark.parametrize(
    "path",
    [
        PureWindowsPath(r"\\server\share\registry"),
        PureWindowsPath(r"C:\registry\stream:name"),
        PureWindowsPath("registry"),
    ],
)
def test_a_network_or_stream_path_is_refused_before_any_handle_opens(path):
    with pytest.raises(RegistryPrivacyError) as caught:
        windows._open_chain(object.__new__(windows._WindowsAPI), path)
    assert caught.value.reason is RegistryPrivacyReason.NOT_LOCAL_NTFS
    assert str(path) in str(caught.value)


def test_a_windows_refusal_survives_a_process_pool():
    refusal = RegistryPrivacyError(PATH, RegistryPrivacyReason.WINDOWS_ACL)
    restored = pickle.loads(pickle.dumps(refusal))
    assert str(restored) == str(refusal)
    assert restored.guest_message() == GUEST_MESSAGE
