import ctypes
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest

from podcast_mcp.util import registry_backup_windows as windows
from podcast_mcp.util.registry_backup_windows import BackupDirectory


@pytest.mark.parametrize(
    "name",
    [
        "backup.sqlite:secret",
        "NUL",
        "con.sqlite",
        "COM1.bak",
        "LPT9",
        "COM¹.txt",
        "backup.",
        "backup ",
        "bad?.sqlite",
        "nested\\backup.sqlite",
    ],
)
def test_windows_final_name_refused_before_filesystem_access(name, monkeypatch):
    directory = object.__new__(BackupDirectory)
    directory.path = PureWindowsPath("C:/private")
    inspected = []
    monkeypatch.setattr("os.path.lexists", lambda path: inspected.append(path) or False)
    with pytest.raises(PermissionError, match="unambiguous"):
        directory.exists(name)
    assert inspected == []


@pytest.mark.parametrize("site", ["directory", "snapshot-reader"])
@pytest.mark.parametrize("error", [2, 3, 5])
def test_failed_windows_open_preserves_cached_missing_path_error(monkeypatch, site, error):
    events = []
    closed = []
    current = {"error": error}
    invalid_handle = ctypes.c_void_p(-1).value

    def create_file(*_args):
        events.append("CreateFileW")
        return invalid_handle

    def get_last_error():
        events.append("get_last_error")
        value = current["error"]
        current["error"] = 0
        return value

    def win_error(code=0):
        events.append(("WinError", code))
        error_type = PermissionError if code == 5 else FileNotFoundError
        return error_type(code, "native file open failed")

    native = SimpleNamespace(get_last_error=get_last_error, WinError=win_error)
    api = SimpleNamespace(kernel=SimpleNamespace(CreateFileW=create_file), close=closed.append)
    monkeypatch.setattr(windows, "_native_ctypes", native)

    if site == "directory":
        opened = windows._WindowsAPI.__new__(windows._WindowsAPI)
        opened.kernel = api.kernel

        def action():
            opened.open_directory(Path("Z:/missing"))
    else:
        directory = BackupDirectory.__new__(BackupDirectory)
        directory.path = Path("Z:/private")
        directory._api = api
        directory.verify_file = lambda _name, _expected: None

        def action():
            with directory.snapshot_reader("snapshot.sqlite", (1, 2)):
                pytest.fail("a missing snapshot reader must refuse the invalid handle")

    expected_error = PermissionError if error == 5 else FileNotFoundError
    with pytest.raises(expected_error) as caught:
        action()
    assert caught.value.errno == error
    assert str(caught.value) == f"[Errno {error}] native file open failed"
    assert events == ["CreateFileW", "get_last_error", ("WinError", error)]
    assert closed == [], "invalid handles are never transferred to the cleanup owner"


def _scope_api(monkeypatch, denials):
    opened = []

    class Api:
        def open_file(self, path):
            opened.append(path)
            if denials:
                denials.pop()
                error = PermissionError(13, "Permission denied")
                error.winerror = 5
                raise error
            return len(opened)

        def verify_handle(self, *_args, **_kwargs):
            return None

        def close(self, _handle):
            return None

    monkeypatch.setattr(windows, "_WindowsAPI", Api)
    monkeypatch.setattr(windows, "_open_chain", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(windows, "_verify_chain", lambda *_args: None)
    return opened


def test_registry_scope_retries_an_access_denied_sidecar_open_before_the_first_yield(monkeypatch):
    opened = _scope_api(monkeypatch, denials=[1, 2])

    with windows.registry_scope(Path("Z:/private"), ("registry.db",), create=False) as verify:
        verify()

    assert len(opened) == 6


def test_registry_scope_raises_the_original_error_when_the_denial_persists(monkeypatch):
    ticks = iter(range(1000))
    real_retry = windows.retry_access_denied
    monkeypatch.setattr(
        windows,
        "retry_access_denied",
        lambda step: real_retry(
            step, monotonic=lambda: float(next(ticks)), sleep=lambda _seconds: None
        ),
    )
    _scope_api(monkeypatch, denials=list(range(10_000)))

    with pytest.raises(PermissionError) as caught:
        with windows.registry_scope(Path("Z:/private"), ("registry.db",), create=False):
            pytest.fail("a persistent denial must not reach the body")

    assert "terminal_reason=deadline" in caught.value.__notes__[0]
