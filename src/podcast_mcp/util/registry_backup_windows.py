from __future__ import annotations

import ctypes
import importlib
import os
import stat
from ctypes import wintypes
from pathlib import Path
from typing import Any

from podcast_mcp.util.registry_backup_posix import Identity, identity

_native_ctypes: Any = ctypes
_PRIVATE_UNTRUSTED_ACCESS_MASK = 0xFFFFFFFF
_GENERIC_ALL = 0x10000000
_GENERIC_WRITE = 0x40000000
_DELETE = 0x00010000
_WRITE_DAC = 0x00040000
_WRITE_OWNER = 0x00080000
_FILE_ADD_FILE = 0x00000002
_FILE_WRITE_EA = 0x00000010
_FILE_DELETE_CHILD = 0x00000040
_FILE_WRITE_ATTRIBUTES = 0x00000100
_ANCESTOR_UNTRUSTED_ACCESS_MASK = (
    _GENERIC_ALL
    | _GENERIC_WRITE
    | _DELETE
    | _WRITE_DAC
    | _WRITE_OWNER
    | _FILE_ADD_FILE
    | _FILE_WRITE_EA
    | _FILE_DELETE_CHILD
    | _FILE_WRITE_ATTRIBUTES
)


def _validate_name(name: str) -> None:
    device = name.split(".", 1)[0].rstrip(" ").upper()
    reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    reserved.update(prefix + number for prefix in ("COM", "LPT") for number in "123456789¹²³")
    if (
        not name
        or name in (".", "..")
        or name.endswith((".", " "))
        or any(ord(character) < 32 or character in '<>:"/\\|?*' for character in name)
        or device in reserved
    ):
        raise PermissionError("backup names must denote an unambiguous Windows regular file")


class _SecurityAttributes(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.DWORD),
        ("descriptor", ctypes.c_void_p),
        ("inherit", wintypes.BOOL),
    ]


class _FileInformation(ctypes.Structure):
    _fields_ = [
        ("attributes", wintypes.DWORD),
        ("created", wintypes.FILETIME),
        ("accessed", wintypes.FILETIME),
        ("written", wintypes.FILETIME),
        ("volume", wintypes.DWORD),
        ("size_high", wintypes.DWORD),
        ("size_low", wintypes.DWORD),
        ("links", wintypes.DWORD),
        ("index_high", wintypes.DWORD),
        ("index_low", wintypes.DWORD),
    ]


class _AclHeader(ctypes.Structure):
    _fields_ = [
        ("revision", ctypes.c_byte),
        ("reserved", ctypes.c_byte),
        ("size", wintypes.WORD),
        ("count", wintypes.WORD),
        ("reserved2", wintypes.WORD),
    ]


class _AllowAce(ctypes.Structure):
    _fields_ = [
        ("kind", ctypes.c_byte),
        ("flags", ctypes.c_byte),
        ("size", wintypes.WORD),
        ("mask", wintypes.DWORD),
        ("sid", wintypes.DWORD),
    ]


class _RenameInformation(ctypes.Structure):
    _fields_ = [
        ("replace", wintypes.DWORD),
        ("root", wintypes.HANDLE),
        ("length", wintypes.DWORD),
        ("name", wintypes.WCHAR * 1),
    ]


class _WindowsAPI:
    def __init__(self) -> None:
        loader = _native_ctypes.WinDLL
        self.kernel: Any = loader("kernel32", use_last_error=True)
        self.security: Any = loader("advapi32", use_last_error=True)
        self.crt: Any = importlib.import_module("msvcrt")
        definitions = [
            (
                self.kernel.GetVolumeInformationByHandleW,
                [
                    wintypes.HANDLE,
                    wintypes.LPWSTR,
                    wintypes.DWORD,
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    wintypes.LPWSTR,
                    wintypes.DWORD,
                ],
                wintypes.BOOL,
            ),
            (
                self.security.LookupAccountNameW,
                [
                    wintypes.LPCWSTR,
                    wintypes.LPCWSTR,
                    ctypes.c_void_p,
                    ctypes.POINTER(wintypes.DWORD),
                    wintypes.LPWSTR,
                    ctypes.POINTER(wintypes.DWORD),
                    ctypes.c_void_p,
                ],
                wintypes.BOOL,
            ),
            (
                self.kernel.CreateFileW,
                [
                    wintypes.LPCWSTR,
                    wintypes.DWORD,
                    wintypes.DWORD,
                    ctypes.c_void_p,
                    wintypes.DWORD,
                    wintypes.DWORD,
                    wintypes.HANDLE,
                ],
                wintypes.HANDLE,
            ),
            (self.kernel.CloseHandle, [wintypes.HANDLE], wintypes.BOOL),
            (self.kernel.LocalFree, [ctypes.c_void_p], ctypes.c_void_p),
            (
                self.kernel.GetFileInformationByHandle,
                [wintypes.HANDLE, ctypes.POINTER(_FileInformation)],
                wintypes.BOOL,
            ),
            (
                self.kernel.SetFileInformationByHandle,
                [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
                wintypes.BOOL,
            ),
            (
                self.kernel.CreateDirectoryW,
                [wintypes.LPCWSTR, ctypes.POINTER(_SecurityAttributes)],
                wintypes.BOOL,
            ),
            (self.kernel.GetCurrentProcess, [], wintypes.HANDLE),
            (
                self.security.OpenProcessToken,
                [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)],
                wintypes.BOOL,
            ),
            (
                self.security.GetTokenInformation,
                [
                    wintypes.HANDLE,
                    ctypes.c_int,
                    ctypes.c_void_p,
                    wintypes.DWORD,
                    ctypes.POINTER(wintypes.DWORD),
                ],
                wintypes.BOOL,
            ),
            (
                self.security.ConvertSidToStringSidW,
                [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
                wintypes.BOOL,
            ),
            (
                self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW,
                [
                    wintypes.LPCWSTR,
                    wintypes.DWORD,
                    ctypes.POINTER(ctypes.c_void_p),
                    ctypes.c_void_p,
                ],
                wintypes.BOOL,
            ),
            (
                self.security.GetSecurityInfo,
                [
                    wintypes.HANDLE,
                    ctypes.c_int,
                    wintypes.DWORD,
                    ctypes.POINTER(ctypes.c_void_p),
                    ctypes.c_void_p,
                    ctypes.POINTER(ctypes.c_void_p),
                    ctypes.c_void_p,
                    ctypes.POINTER(ctypes.c_void_p),
                ],
                wintypes.DWORD,
            ),
            (
                self.security.GetAce,
                [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)],
                wintypes.BOOL,
            ),
        ]
        for function, arguments, result in definitions:
            function.argtypes, function.restype = arguments, result
        token = wintypes.HANDLE()
        self.check(
            self.security.OpenProcessToken(self.kernel.GetCurrentProcess(), 8, ctypes.byref(token))
        )
        try:
            size = wintypes.DWORD()
            self.security.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            buffer = ctypes.create_string_buffer(size.value)
            self.check(
                self.security.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size))
            )
            self.user_sid = self.sid_string(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0])
        finally:
            self.kernel.CloseHandle(token)
        self.trusted = {self.user_sid, "S-1-5-18", "S-1-5-32-544"}
        # The Windows servicing identity owns ordinary system ancestry.
        sid_size, domain_size, kind = wintypes.DWORD(), wintypes.DWORD(), wintypes.DWORD()
        self.security.LookupAccountNameW(
            None,
            "NT SERVICE\\TrustedInstaller",
            None,
            ctypes.byref(sid_size),
            None,
            ctypes.byref(domain_size),
            ctypes.byref(kind),
        )
        sid_buffer = ctypes.create_string_buffer(sid_size.value)
        domain = ctypes.create_unicode_buffer(domain_size.value)
        self.check(
            self.security.LookupAccountNameW(
                None,
                "NT SERVICE\\TrustedInstaller",
                sid_buffer,
                ctypes.byref(sid_size),
                domain,
                ctypes.byref(domain_size),
                ctypes.byref(kind),
            )
        )
        self.ancestry_trusted = self.trusted | {self.sid_string(sid_buffer)}

    @staticmethod
    def check(result: Any) -> None:
        if not result:
            error = _native_ctypes.get_last_error()
            if error in (80, 183):
                raise FileExistsError("backup destination already exists")
            raise _native_ctypes.WinError(error)

    def sid_string(self, sid: Any) -> str:
        output = ctypes.c_void_p()
        self.check(self.security.ConvertSidToStringSidW(sid, ctypes.byref(output)))
        try:
            return ctypes.wstring_at(output)
        finally:
            self.kernel.LocalFree(output)

    def private_descriptor(self) -> ctypes.c_void_p:
        descriptor = ctypes.c_void_p()
        sddl = f"O:{self.user_sid}D:P(A;;FA;;;{self.user_sid})(A;;FA;;;SY)(A;;FA;;;BA)"
        self.check(
            self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, 1, ctypes.byref(descriptor), None
            )
        )
        return descriptor

    def open_directory(self, path: Path) -> Any:
        handle = self.kernel.CreateFileW(str(path), 0x20080, 3, None, 3, 0x02200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise _native_ctypes.WinError()
        return handle

    def verify_handle(self, handle: Any, *, private: bool, directory: bool) -> _FileInformation:
        info = _FileInformation()
        self.check(self.kernel.GetFileInformationByHandle(handle, ctypes.byref(info)))
        if info.attributes & 0x400 or bool(info.attributes & 0x10) != directory:
            raise PermissionError("backup paths must not contain reparse points")
        filesystem = ctypes.create_unicode_buffer(32)
        self.check(
            self.kernel.GetVolumeInformationByHandleW(
                handle, None, 0, None, None, None, filesystem, len(filesystem)
            )
        )
        if filesystem.value.upper() != "NTFS":
            raise PermissionError("registry backup requires local NTFS storage")
        if not info.index_high and not info.index_low:
            raise PermissionError("backup filesystem must provide persistent file identities")
        owner, acl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        result = self.security.GetSecurityInfo(
            handle,
            1,
            5,
            ctypes.byref(owner),
            None,
            ctypes.byref(acl),
            None,
            ctypes.byref(descriptor),
        )
        if result:
            raise OSError(result, "cannot inspect backup security descriptor")
        try:
            trusted = self.trusted if private else self.ancestry_trusted
            if not acl or self.sid_string(owner) not in trusted:
                raise PermissionError("backup path has an untrusted owner or unrestricted DACL")
            count = ctypes.cast(acl, ctypes.POINTER(_AclHeader)).contents.count
            for index in range(count):
                pointer = ctypes.c_void_p()
                self.check(self.security.GetAce(acl, index, ctypes.byref(pointer)))
                ace = ctypes.cast(pointer, ctypes.POINTER(_AllowAce)).contents
                if ace.flags & 8 or ace.kind == 1:
                    continue
                if ace.kind != 0:
                    raise PermissionError("backup DACL contains an unsupported access grant")
                if pointer.value is None:
                    raise OSError("cannot inspect backup ACL entry")
                sid = self.sid_string(pointer.value + _AllowAce.sid.offset)
                forbidden = (
                    _PRIVATE_UNTRUSTED_ACCESS_MASK if private else _ANCESTOR_UNTRUSTED_ACCESS_MASK
                )
                if sid not in trusted and ace.mask & forbidden:
                    raise PermissionError("backup path grants another account unsafe access")
        finally:
            self.kernel.LocalFree(descriptor)
        return info


class BackupDirectory:
    def __init__(self, path: Path) -> None:
        if not path.drive or path.drive.startswith("\\\\") or any(":" in p for p in path.parts[1:]):
            raise PermissionError(
                "registry backup requires a local NTFS path without alternate streams"
            )
        for name in path.parts[1:]:
            _validate_name(name)
        self.path, self._api = path, _WindowsAPI()
        self._handles: list[tuple[Path, Any, tuple[int, int, int]]] = []
        try:
            for part in [*reversed(path.parents), path]:
                handle = self._api.open_directory(part)
                try:
                    info = self._api.verify_handle(handle, private=part == path, directory=True)
                    self._handles.append(
                        (part, handle, (info.volume, info.index_high, info.index_low))
                    )
                except BaseException:
                    self._api.kernel.CloseHandle(handle)
                    raise
            self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self) -> None:
        for path, handle, expected in self._handles:
            info = self._api.verify_handle(handle, private=path == self.path, directory=True)
            if (info.volume, info.index_high, info.index_low) != expected:
                raise PermissionError("backup directory identity changed")
            reopened = self._api.open_directory(path)
            try:
                current = self._api.verify_handle(
                    reopened, private=path == self.path, directory=True
                )
                if (current.volume, current.index_high, current.index_low) != expected:
                    raise PermissionError("backup directory path changed")
            finally:
                self._api.kernel.CloseHandle(reopened)

    def exists(self, name: str) -> bool:
        _validate_name(name)
        return os.path.lexists(self.path / name)

    def create_workspace(self, name: str) -> Identity:
        _validate_name(name)
        self.verify()
        descriptor = self._api.private_descriptor()
        try:
            attributes = _SecurityAttributes(ctypes.sizeof(_SecurityAttributes), descriptor, False)
            self._api.check(
                self._api.kernel.CreateDirectoryW(str(self.path / name), ctypes.byref(attributes))
            )
        finally:
            self._api.kernel.LocalFree(descriptor)
        return identity((self.path / name).stat(follow_symlinks=False))

    def create_file(self, name: str) -> int:
        _validate_name(name)
        self.verify()
        descriptor = self._api.private_descriptor()
        try:
            attributes = _SecurityAttributes(ctypes.sizeof(_SecurityAttributes), descriptor, False)
            handle = self._api.kernel.CreateFileW(
                str(self.path / name), 0xC0030000, 3, ctypes.byref(attributes), 1, 0x00200000, None
            )
        finally:
            self._api.kernel.LocalFree(descriptor)
        if handle == ctypes.c_void_p(-1).value:
            raise _native_ctypes.WinError()
        try:
            self._api.verify_handle(handle, private=True, directory=False)
            return self._api.crt.open_osfhandle(handle, os.O_RDWR | 0x8000)
        except BaseException:
            self._api.kernel.CloseHandle(handle)
            raise

    def open_snapshot(self, name: str, expected: Identity) -> int:
        self.verify_file(name, expected)
        handle = self._api.kernel.CreateFileW(
            str(self.path / name), 0x80020000, 3, None, 3, 0x00200000, None
        )
        if handle == ctypes.c_void_p(-1).value:
            raise _native_ctypes.WinError()
        try:
            self._api.verify_handle(handle, private=True, directory=False)
            fd = self._api.crt.open_osfhandle(handle, os.O_RDONLY | 0x8000)
        except BaseException:
            self._api.kernel.CloseHandle(handle)
            raise
        if identity(os.fstat(fd)) != expected:
            os.close(fd)
            raise PermissionError("backup snapshot identity changed")
        return fd

    def verify_file(self, name: str, expected: Identity) -> None:
        _validate_name(name)
        self.verify()
        if identity((self.path / name).stat(follow_symlinks=False)) != expected:
            raise PermissionError("backup file identity changed")
        handle = self._api.kernel.CreateFileW(
            str(self.path / name), 0x20080, 7, None, 3, 0x00200000, None
        )
        if handle == ctypes.c_void_p(-1).value:
            raise _native_ctypes.WinError()
        try:
            self._api.verify_handle(handle, private=True, directory=False)
        finally:
            self._api.kernel.CloseHandle(handle)

    def publish(self, staged: str, final: str, expected: Identity, fd: int) -> None:
        _validate_name(final)
        self.verify_file(staged, expected)
        name = str(self.path / final).encode("utf-16-le")
        buffer = ctypes.create_string_buffer(_RenameInformation.name.offset + len(name) + 2)
        info = ctypes.cast(buffer, ctypes.POINTER(_RenameInformation)).contents
        info.replace, info.root, info.length = 0, None, len(name)
        ctypes.memmove(ctypes.addressof(buffer) + _RenameInformation.name.offset, name, len(name))
        self._api.check(
            self._api.kernel.SetFileInformationByHandle(
                self._api.crt.get_osfhandle(fd), 3, buffer, len(buffer)
            )
        )

    def sync(self) -> None:
        # Win32 has no portable directory fsync. File data is flushed before native rename.
        self.verify()

    def remove_file(self, name: str, expected: Identity) -> None:
        path = self.path / name
        if not os.path.lexists(path):
            return
        if identity(path.stat(follow_symlinks=False)) != expected or path.is_symlink():
            raise PermissionError("refusing to remove a substituted backup file")
        path.unlink()

    def remove_workspace(self, name: str, expected: Identity) -> None:
        path = self.path / name
        if identity(path.stat(follow_symlinks=False)) != expected or not stat.S_ISDIR(
            path.stat(follow_symlinks=False).st_mode
        ):
            raise PermissionError("refusing to remove a substituted backup workspace")
        path.rmdir()

    def close(self) -> None:
        while self._handles:
            self._api.kernel.CloseHandle(self._handles.pop()[1])
