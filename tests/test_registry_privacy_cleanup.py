from __future__ import annotations

from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest

from podcast_mcp.util import registry_backup_posix as posix
from podcast_mcp.util import registry_backup_windows as windows


@pytest.mark.parametrize("platform", ["posix", "windows"])
def test_constructor_refusal_preserves_error_and_drains_acquired_ancestors(monkeypatch, platform):
    failure = PermissionError("native ancestry refused")
    close_failure = KeyboardInterrupt("native close interrupted")
    acquired = []
    closed = []

    def open_directory(*args, **kwargs):
        if len(acquired) == 2:
            raise failure
        handle = len(acquired) + 101
        acquired.append(handle)
        return handle

    def close(handle):
        closed.append(handle)
        if handle == acquired[-1]:
            raise close_failure

    with monkeypatch.context() as patch:
        if platform == "posix":
            patch.setattr(posix, "descriptor_walk_supported", lambda: True)
            patch.setattr(posix, "open_nofollow_dir", open_directory)
            patch.setattr(posix, "_check_directory", lambda *args, **kwargs: None)
            patch.setattr(posix.os, "close", close)
            constructor, path = posix.BackupDirectory, Path("/owned/source")
        else:
            api = SimpleNamespace(
                open_directory=open_directory,
                close=close,
                verify_handle=lambda *args, **kwargs: SimpleNamespace(
                    volume=1, index_high=0, index_low=1
                ),
            )
            patch.setattr(windows, "_WindowsAPI", lambda: api)
            constructor, path = windows.BackupDirectory, PureWindowsPath("R:/owned/source")
        with pytest.raises(PermissionError) as caught:
            constructor(path)
    assert caught.value is failure
    assert closed == list(reversed(acquired))


def test_windows_close_drains_every_handle_and_reports_first_failure():
    first = OSError("first close failure")
    later = KeyboardInterrupt("later close cancellation")
    closed = []

    def close(handle):
        closed.append(handle)
        raise first if handle == 3 else later

    directory = object.__new__(windows.BackupDirectory)
    directory._api = SimpleNamespace(close=close)
    directory._handles = [(PureWindowsPath("R:/"), handle, (1, 0, handle)) for handle in (1, 2, 3)]
    with pytest.raises(OSError) as caught:
        directory.close()
    assert caught.value is first
    assert closed == [3, 2, 1]
    assert directory._handles == []
    directory.close()
    assert closed == [3, 2, 1]
