from __future__ import annotations

import ctypes
from types import SimpleNamespace

import pytest

from podcast_mcp.util import registry_backup_windows as windows


@pytest.mark.parametrize("flags", [1 | 8, 2 | 8, 1 | 2 | 8, 1 | 2])
@pytest.mark.parametrize("trustee", ["everyone", "owner"])
def test_private_directory_child_grants_are_limited_to_trusted_accounts(flags, trustee):
    api = object.__new__(windows._WindowsAPI)
    api.trusted = {"owner", "system", "administrators"}
    api.ancestry_trusted = api.trusted
    header = windows._AclHeader()
    header.count = 1
    ace = windows._AllowAce()
    ace.kind, ace.flags, ace.mask = 0, flags, 1

    def information(handle, pointer):
        info = ctypes.cast(pointer, ctypes.POINTER(windows._FileInformation)).contents
        info.attributes, info.index_low = 0x10, 1
        return True

    def volume(handle, name, length, serial, maximum, filesystem_flags, filesystem, size):
        filesystem.value = "NTFS"
        return True

    def security(handle, kind, requested, owner, group, acl, sacl, descriptor):
        ctypes.cast(owner, ctypes.POINTER(ctypes.c_void_p))[0] = 1
        ctypes.cast(acl, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(header)
        return 0

    def get_ace(acl, index, pointer):
        ctypes.cast(pointer, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(ace)
        return True

    api.kernel = SimpleNamespace(
        GetFileInformationByHandle=information,
        GetVolumeInformationByHandleW=volume,
        LocalFree=lambda descriptor: None,
    )
    api.security = SimpleNamespace(GetSecurityInfo=security, GetAce=get_ace)
    api.sid_string = lambda pointer: "owner" if getattr(pointer, "value", pointer) == 1 else trustee
    if trustee == "everyone":
        with pytest.raises(PermissionError):
            api.verify_handle(123, private=True, directory=True)
    else:
        assert api.verify_handle(123, private=True, directory=True).index_low == 1


def test_private_directory_creation_descriptor_protects_future_children(tmp_path):
    api = object.__new__(windows._WindowsAPI)
    api.user_sid = "S-1-5-21-101-102-103-1001"
    supplied = []

    def convert(sddl, revision, descriptor, size):
        supplied.append(sddl)
        ctypes.cast(descriptor, ctypes.POINTER(ctypes.c_void_p))[0] = 1
        return True

    api.security = SimpleNamespace(ConvertStringSecurityDescriptorToSecurityDescriptorW=convert)
    api.kernel = SimpleNamespace(
        LocalFree=lambda descriptor: None, CreateDirectoryW=lambda *args: True
    )
    directory = object.__new__(windows.BackupDirectory)
    directory._api, directory.path = api, tmp_path
    directory.verify = lambda: None
    child = tmp_path / "private-workspace"
    child.mkdir()
    assert directory.create_workspace(child.name) == (child.stat().st_dev, child.stat().st_ino)
    assert supplied == [
        "O:S-1-5-21-101-102-103-1001D:P"
        "(A;OICI;FA;;;S-1-5-21-101-102-103-1001)"
        "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
    ]
