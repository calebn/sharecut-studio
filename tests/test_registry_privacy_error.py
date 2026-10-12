"""A registry path that is not private is refused with its path and a fix (#1304).

The refusal stays fail-closed: nothing here repairs a path. Each adapter reports the same
message: the CLI as one ``Error:`` line, the owner MCP as a structured refusal, the GUI as an
HTTP 500 whose detail is the message (redacted for a caller that is not the host).
"""

from __future__ import annotations

import os
import pickle
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mcp.client import Client
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_registry import SqliteShareRegistry, reset_share_registry_for_tests
from podcast_mcp.gui.routes.deps import registry_privacy_exception_handler
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.util import registry_backup_posix as posix
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from podcast_mcp.util.registry_privacy_error import (
    REGISTRY_NOT_PRIVATE_CODE,
    RegistryPrivacyError,
    RegistryPrivacyReason,
)

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits")

PIN = "set PODCAST_SHARE_REGISTRY to a registry you own"


@pytest.mark.parametrize(
    ("reason", "mode", "message"),
    [
        (
            RegistryPrivacyReason.FILE_MODE,
            0o100644,
            "registry file '/h/my reg/r.sqlite' must be owned and private (0600) but is mode "
            "0644; run: chmod 0600 '/h/my reg/r.sqlite'",
        ),
        (
            RegistryPrivacyReason.DIRECTORY_MODE,
            0o40755,
            "registry folder '/h/my reg/r.sqlite' must be owned and private (0700) but is mode "
            "0755; run: chmod 0700 '/h/my reg/r.sqlite'",
        ),
        (
            RegistryPrivacyReason.FILE_OWNER,
            None,
            f"registry file '/h/my reg/r.sqlite' is owned by another user; restore your "
            f"ownership of it, or {PIN}",
        ),
        (
            RegistryPrivacyReason.DIRECTORY_OWNER,
            None,
            f"registry folder '/h/my reg/r.sqlite' is owned by another user; restore your "
            f"ownership of it, or {PIN}",
        ),
        (
            RegistryPrivacyReason.FILE_NOT_REGULAR,
            None,
            f"registry file '/h/my reg/r.sqlite' is not a regular file; move it aside, or {PIN}",
        ),
        (
            RegistryPrivacyReason.ACL,
            None,
            "registry path '/h/my reg/r.sqlite' has an extended ACL that grants other accounts "
            "access; remove the extra access entries so only you have access",
        ),
        (
            RegistryPrivacyReason.SYMLINK,
            None,
            "registry path '/h/my reg/r.sqlite' is a symbolic link, which is never followed; "
            f"replace it with the real folder or file, or {PIN}",
        ),
        (
            RegistryPrivacyReason.PARENT_WRITABLE,
            None,
            "folder '/h/my reg/r.sqlite' above the registry lets other users replace entries; "
            "run: chmod go-w '/h/my reg/r.sqlite'",
        ),
        (
            RegistryPrivacyReason.PARENT_WRITABLE_NOT_MINE,
            None,
            "folder '/h/my reg/r.sqlite' above the registry lets other users replace entries; "
            f"ask its owner to remove write access for others, or {PIN}",
        ),
        (
            RegistryPrivacyReason.PARENT_OWNER,
            None,
            "folder '/h/my reg/r.sqlite' above the registry is owned by another user; move the "
            f"registry under a folder you own, or {PIN}",
        ),
    ],
)
def test_message_names_the_path_and_the_fix(reason, mode, message) -> None:
    error = RegistryPrivacyError(Path("/h/my reg/r.sqlite"), reason, mode=mode)

    assert str(error) == message
    assert error.code == REGISTRY_NOT_PRIVATE_CODE
    assert error.path == Path("/h/my reg/r.sqlite")
    assert error.reason is reason
    assert isinstance(error, CodedError)
    assert isinstance(error, PermissionError)


def test_refusal_survives_pickling() -> None:
    error = RegistryPrivacyError(Path("/h/r.sqlite"), RegistryPrivacyReason.FILE_MODE, mode=0o644)

    restored = pickle.loads(pickle.dumps(error))

    assert str(restored) == str(error)
    assert restored.code == REGISTRY_NOT_PRIVATE_CODE
    assert restored.reason is RegistryPrivacyReason.FILE_MODE


@pytest.fixture
def registry_path(tmp_path: Path) -> Path:
    return tmp_path / "reg" / "share_registry.sqlite"


def _refusal(path: Path) -> RegistryPrivacyError:
    with pytest.raises(RegistryPrivacyError) as caught:
        SqliteShareRegistry(path)
    return caught.value


def test_loose_main_file_is_refused_not_repaired(registry_path: Path) -> None:
    SqliteShareRegistry(registry_path).close()
    registry_path.chmod(0o644)

    error = _refusal(registry_path)

    assert str(error) == (
        f"registry file {registry_path} must be owned and private (0600) but is mode 0644; "
        f"run: chmod 0600 {registry_path}"
    )
    assert registry_path.stat().st_mode & 0o777 == 0o644


def test_recovery_after_the_suggested_chmod(registry_path: Path) -> None:
    SqliteShareRegistry(registry_path).close()
    registry_path.chmod(0o644)
    _refusal(registry_path)

    registry_path.chmod(0o600)

    SqliteShareRegistry(registry_path).close()


@pytest.mark.parametrize("suffix", ["-shm", "-wal"])
def test_loose_sidecar_names_the_sidecar(registry_path: Path, suffix: str) -> None:
    registry = SqliteShareRegistry(registry_path)
    registry.recording_key_secret()
    sidecar = Path(f"{registry_path}{suffix}")
    assert sidecar.exists()
    sidecar.chmod(0o644)

    with pytest.raises(RegistryPrivacyError) as caught:
        registry.recording_key_secret()

    assert str(caught.value) == (
        f"registry file {sidecar} must be owned and private (0600) but is mode 0644; "
        f"run: chmod 0600 {sidecar}"
    )
    sidecar.chmod(0o600)
    assert len(registry.recording_key_secret()) == 32
    registry.close()


def test_loose_directory_in_a_running_registry(registry_path: Path) -> None:
    registry = SqliteShareRegistry(registry_path)
    registry_path.parent.chmod(0o755)

    with pytest.raises(RegistryPrivacyError) as caught:
        registry.recording_key_secret()

    assert str(caught.value) == (
        f"registry folder {registry_path.parent} must be owned and private (0700) but is mode "
        f"0755; run: chmod 0700 {registry_path.parent}"
    )
    registry_path.parent.chmod(0o700)
    registry.close()


def test_symlinked_registry_file(registry_path: Path, tmp_path: Path) -> None:
    registry_path.parent.mkdir(mode=0o700)
    real = tmp_path / "elsewhere.sqlite"
    real.touch(mode=0o600)
    registry_path.symlink_to(real)

    error = _refusal(registry_path)

    assert error.reason is RegistryPrivacyReason.SYMLINK
    assert error.path == registry_path


def test_symlinked_folder_above_the_registry(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real)

    error = _refusal(link / "share_registry.sqlite")

    assert error.reason is RegistryPrivacyReason.SYMLINK
    assert error.path == link
    assert str(error).startswith(f"registry path {link} is a symbolic link")


def test_registry_path_that_is_a_folder(registry_path: Path) -> None:
    registry_path.mkdir(parents=True, mode=0o700)

    error = _refusal(registry_path)

    assert error.reason is RegistryPrivacyReason.FILE_NOT_REGULAR
    assert error.path == registry_path


def test_writable_folder_above_the_registry(tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    shared.mkdir()
    shared.chmod(0o777)

    error = _refusal(shared / "reg" / "share_registry.sqlite")

    assert str(error) == (
        f"folder {shared} above the registry lets other users replace entries; "
        f"run: chmod go-w {shared}"
    )


def test_cli_prints_one_line_without_a_traceback(
    minimal_project: Path, registry_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(registry_path))
    reset_share_registry_for_tests()
    SqliteShareRegistry(registry_path).close()
    registry_path.chmod(0o644)

    result = CliRunner().invoke(
        cli_app, ["review", "list-shares", "--project", str(minimal_project)]
    )

    assert result.exit_code == 1
    assert result.stderr.strip() == (
        f"Error: registry file {registry_path} must be owned and private (0600) but is mode "
        f"0644; run: chmod 0600 {registry_path} (code {REGISTRY_NOT_PRIVATE_CODE}) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    )
    assert "Traceback" not in result.output + result.stderr


@pytest.mark.asyncio
async def test_owner_mcp_tool_returns_the_refusal(
    minimal_project: Path, registry_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(registry_path))
    reset_share_registry_for_tests()
    SqliteShareRegistry(registry_path).close()
    registry_path.chmod(0o644)

    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "create_record_room_tool", {"project_path": str(minimal_project)}
        )

    assert result.is_error
    assert result.content[0].text == (
        f"registry file {registry_path} must be owned and private (0600) but is mode 0644; "
        f"run: chmod 0600 {registry_path}"
    )
    assert result.structured_content["error_code"] == REGISTRY_NOT_PRIVATE_CODE


def test_gui_route_gives_the_host_the_path_and_the_fix(
    minimal_project: Path, registry_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(registry_path))
    reset_share_registry_for_tests()
    SqliteShareRegistry(registry_path).close()
    registry_path.chmod(0o644)
    client = TestClient(create_app(), raise_server_exceptions=False)

    response = client.get("/api/shares", params={"path": str(minimal_project)})

    assert response.status_code == 500
    assert response.headers["X-Sharecut-Error-Code"] == REGISTRY_NOT_PRIVATE_CODE
    assert response.json()["detail"] == (
        f"registry file {registry_path} must be owned and private (0600) but is mode 0644; "
        f"run: chmod 0600 {registry_path}"
    )


def test_gui_handler_redacts_the_path_for_a_relayed_guest(tmp_path: Path) -> None:
    app = FastAPI()
    app.add_exception_handler(RegistryPrivacyError, registry_privacy_exception_handler)

    @app.get("/refuse")
    def refuse() -> None:
        raise RegistryPrivacyError(
            tmp_path / "reg" / "share_registry.sqlite", RegistryPrivacyReason.FILE_MODE, mode=0o644
        )

    client = TestClient(app, raise_server_exceptions=False)

    guest = client.get("/refuse", headers={RELAYED_REQUEST_HEADER: "1"})

    assert guest.status_code == 500
    assert guest.headers["X-Sharecut-Error-Code"] == REGISTRY_NOT_PRIVATE_CODE
    assert str(tmp_path) not in guest.text
    assert "[path]" in guest.text


@pytest.fixture
def other_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(os, "geteuid", lambda: os.getuid() + 1)


def test_file_owned_by_another_user(registry_path: Path, other_user: None) -> None:
    registry_path.parent.mkdir(mode=0o700)
    registry_path.touch(mode=0o600)

    with pytest.raises(RegistryPrivacyError) as caught:
        posix._check_file_state(registry_path.stat(), registry_path, str(registry_path))

    assert caught.value.reason is RegistryPrivacyReason.FILE_OWNER
    assert caught.value.path == registry_path


@pytest.mark.parametrize(
    ("private", "reason"),
    [
        (True, RegistryPrivacyReason.DIRECTORY_OWNER),
        (False, RegistryPrivacyReason.PARENT_OWNER),
    ],
)
def test_folder_owned_by_another_user(
    tmp_path: Path, other_user: None, private: bool, reason: RegistryPrivacyReason
) -> None:
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(RegistryPrivacyError) as caught:
            posix._check_directory(fd, tmp_path, private=private)
    finally:
        os.close(fd)

    assert caught.value.reason is reason
    assert caught.value.path == tmp_path
