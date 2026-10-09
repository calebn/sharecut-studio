from pathlib import PureWindowsPath

import pytest

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
