"""A share guest never reads a host path from a registry privacy refusal (#1304).

The refusal carries the host's message and a fixed guest message; every guest or relayed
surface reports the fixed one, so nothing about the host's folders reaches a guest, whatever
the path looks like (spaces, apostrophes).
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_registry import SqliteShareRegistry, reset_share_registry_for_tests
from podcast_mcp.gui.routes.guest_errors import guest_http_error, guest_ws_error
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.remote_mcp.protocol import _tool_failure, handle_mcp_jsonrpc
from podcast_mcp.util.registry_privacy_error import (
    REGISTRY_NOT_PRIVATE_CODE,
    RegistryPrivacyError,
    RegistryPrivacyReason,
)
from podcast_mcp.util.tool_refusal import guest_failure_detail, tool_refusal

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits")

HOME_NAME = "Mike's Home"
RPC = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "guest_get_project"}}
log = logging.getLogger(__name__)


def _error(path: Path) -> RegistryPrivacyError:
    return RegistryPrivacyError(path, RegistryPrivacyReason.FILE_MODE, mode=0o644)


@pytest.fixture
def loose_registry(
    tmp_path: Path, minimal_project: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[str, Path]:
    """A minted share whose registry then becomes group-readable; returns (token, registry)."""
    registry = tmp_path / HOME_NAME / ".podcast_mcp" / "share_registry.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(registry))
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    reset_share_registry_for_tests()
    artifacts = Path(load_project(minimal_project).workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="guest")
    share = ShareService(ws).create(
        review_version_id=version["id"],
        public_base_url="https://share.example",
        capabilities=["play", "view", "mcp"],
    )
    reset_share_registry_for_tests()
    registry.chmod(0o644)
    return share["token"], registry


def _leaks(text: str, registry: Path) -> list[str]:
    fragments = [str(registry), str(registry.parent), "Mike", "Home", ".podcast_mcp", "sqlite"]
    return [fragment for fragment in fragments if fragment in text]


def test_error_holds_a_host_message_and_a_fixed_guest_message(tmp_path: Path) -> None:
    error = _error(tmp_path / HOME_NAME / "r.sqlite")

    assert "Mike" in str(error)
    assert (
        error.guest_message()
        == "The host's sharing setup needs attention; ask the host to check it."
    )
    assert "chmod" not in error.guest_message()
    assert "/" not in error.guest_message()


def test_tool_refusal_gives_a_guest_the_fixed_message(tmp_path: Path) -> None:
    error = _error(tmp_path / HOME_NAME / "r.sqlite")

    guest = tool_refusal(error, for_guest=True)
    host = tool_refusal(error)

    assert guest is not None and host is not None
    assert guest.message == "The host's sharing setup needs attention; ask the host to check it."
    assert guest.code == host.code == REGISTRY_NOT_PRIVATE_CODE
    assert host.message == str(error)
    assert (
        guest_failure_detail(error)
        == "The host's sharing setup needs attention; ask the host to check it."
    )


def test_remote_mcp_resolve_gives_the_guest_the_fixed_message(
    loose_registry: tuple[str, Path],
) -> None:
    token, registry = loose_registry

    response = handle_mcp_jsonrpc(token, {**RPC, "method": "initialize"})

    assert response is not None
    assert response["error"]["code"] == -32603
    assert (
        response["error"]["message"]
        == "The host's sharing setup needs attention; ask the host to check it."
    )
    assert response["error"]["data"] == {"error_code": REGISTRY_NOT_PRIVATE_CODE}
    assert _leaks(json.dumps(response), registry) == []


def test_remote_mcp_tool_failure_gives_the_guest_the_fixed_message(tmp_path: Path) -> None:
    registry = tmp_path / HOME_NAME / "share_registry.sqlite"

    response = _tool_failure(1, "guest_get_project", _error(registry))

    assert response["result"]["isError"] is True
    assert response["result"]["structuredContent"]["error_code"] == REGISTRY_NOT_PRIVATE_CODE
    assert (
        response["result"]["content"][0]["text"]
        == "The host's sharing setup needs attention; ask the host to check it."
    )
    assert _leaks(json.dumps(response), registry) == []


GUEST_ROUTES = [
    ("GET", "/api/review/{token}/project"),
    ("GET", "/api/review/{token}/features"),
    ("GET", "/mcp/{token}"),
    ("POST", "/mcp/{token}/mcp"),
    ("POST", "/r/{token}/mcp"),
]


@pytest.mark.parametrize(("method", "route"), GUEST_ROUTES)
def test_guest_routes_return_the_coded_guest_message(
    loose_registry: tuple[str, Path], method: str, route: str
) -> None:
    token, registry = loose_registry
    client = TestClient(create_app(), raise_server_exceptions=False)

    response = client.request(
        method, route.format(token=token), json=RPC if method == "POST" else None
    )

    assert response.status_code == 500
    assert response.headers["X-Sharecut-Error-Code"] == REGISTRY_NOT_PRIVATE_CODE
    assert (
        response.json()["detail"]
        == "The host's sharing setup needs attention; ask the host to check it."
    )
    assert _leaks(response.text, registry) == []


def _surface_tool_refusal(error: RegistryPrivacyError) -> str:
    refusal = tool_refusal(error, for_guest=True)
    assert refusal is not None
    return refusal.message


def _surface_failure_detail(error: RegistryPrivacyError) -> str:
    return guest_failure_detail(error) or ""


def _surface_http(error: RegistryPrivacyError) -> str:
    failure = guest_http_error(error, logger=log, operation="probe")
    return json.dumps([failure.status_code, failure.detail, failure.headers])


def _surface_ws(error: RegistryPrivacyError) -> str:
    failure = guest_ws_error(error, logger=log, operation="probe")
    return json.dumps([failure.detail, failure.code, failure.close_reason])


def _surface_mcp_tool_failure(error: RegistryPrivacyError) -> str:
    return json.dumps(_tool_failure(1, "probe", error))


GUEST_SURFACES: dict[str, Callable[[RegistryPrivacyError], str]] = {
    "tool_refusal": _surface_tool_refusal,
    "guest_failure_detail": _surface_failure_detail,
    "guest_http_error": _surface_http,
    "guest_ws_error": _surface_ws,
    "remote_mcp_tool_failure": _surface_mcp_tool_failure,
}


@pytest.mark.parametrize("surface", sorted(GUEST_SURFACES))
@pytest.mark.parametrize("name", ["plain", "SENTINEL-PATH-'q' \"d\" $HOME", HOME_NAME])
def test_no_guest_surface_shows_the_path(surface: str, name: str, tmp_path: Path) -> None:
    path = tmp_path / name / "share_registry.sqlite"

    shown = GUEST_SURFACES[surface](_error(path))

    assert str(tmp_path) not in shown
    assert name not in shown
    assert "share_registry" not in shown
    assert "chmod" not in shown


def test_backup_registry_cli_prints_the_error_line_and_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = tmp_path / "reg" / "share_registry.sqlite"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(registry))
    reset_share_registry_for_tests()
    SqliteShareRegistry(registry).close()
    registry.chmod(0o644)

    result = CliRunner().invoke(cli_app, ["review", "backup-registry"])

    assert result.exit_code == 1
    assert result.stderr.strip() == (
        f"Error: registry file {registry} must be owned and private (0600) but is mode 0644; "
        f"run: chmod 0600 {registry} (code {REGISTRY_NOT_PRIVATE_CODE}) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    )


def test_share_lookup_crash_is_a_fixed_json_500(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def crash(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError(f"boom {tmp_path}")

    monkeypatch.setattr("podcast_mcp.gui.middleware_share_identity.lookup_share", crash)
    client = TestClient(create_app(), raise_server_exceptions=False)

    response = client.get("/api/review/some-token/project")

    assert response.status_code == 500
    assert response.json() == {"detail": "internal error"}
