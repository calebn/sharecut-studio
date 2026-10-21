"""A review artifacts or staging folder that is not private is a coded refusal (#1322).

The host reads a message that names the folder and the fix; a share guest reads a fixed line
with no path. Every adapter reports the same ``review_artifacts_not_private`` code.
"""

from __future__ import annotations

import json
import logging
import os
import pickle
import sys
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mcp.client import Client
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.gui.routes.deps import host_setup_exception_handler
from podcast_mcp.gui.routes.guest_errors import guest_http_error, guest_ws_error
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import load_project
from podcast_mcp.services.collaboration import review_versions
from podcast_mcp.services.collaboration.review_versions import publish_version, stage_version
from podcast_mcp.services.remote_mcp.protocol import _capability_denial, _tool_failure
from podcast_mcp.util.coded_error import CodedError, HostSetupError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from podcast_mcp.util.review_privacy_error import (
    REVIEW_NOT_PRIVATE_CODE,
    ReviewPrivacyError,
    ReviewPrivacyReason,
)
from podcast_mcp.util.tool_refusal import guest_failure_detail, tool_refusal
from review_platform import requires_safe_failed_cleanup
from review_platform import (
    unmarked_tests_run_as_unsupported_platform as unmarked_tests_run_as_unsupported_platform,
)

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits")

HOME_NAME = "Mike's Home"
log = logging.getLogger(__name__)


def _error(path: Path, reason: ReviewPrivacyReason = ReviewPrivacyReason.ARTIFACTS_WRITABLE):
    return ReviewPrivacyError(path, reason, mode=0o40777)


@pytest.mark.parametrize(
    ("reason", "message"),
    [
        (
            ReviewPrivacyReason.ARTIFACTS_OWNER,
            "review artifacts folder '/h/my ep/review' is owned by another user; "
            "restore your ownership of it, or move the project to a folder you own",
        ),
        (
            ReviewPrivacyReason.ARTIFACTS_WRITABLE,
            "review artifacts folder '/h/my ep/review' must not be writable by group or others "
            "but is mode 0777; run: chmod go-w '/h/my ep/review'",
        ),
        (
            ReviewPrivacyReason.STAGING_OWNER,
            "review staging folder '/h/my ep/review' is owned by another user; "
            "remove it and publish again, or move the project to a folder you own",
        ),
        (
            ReviewPrivacyReason.STAGING_MODE,
            "review staging folder '/h/my ep/review' must be private (0700) but is mode 0777; "
            "run: chmod 0700 '/h/my ep/review'",
        ),
    ],
)
def test_host_message_names_the_path_and_the_fix(reason, message) -> None:
    error = _error(Path("/h/my ep/review"), reason)

    assert str(error) == message
    assert error.code == REVIEW_NOT_PRIVATE_CODE
    assert error.path == Path("/h/my ep/review")
    assert error.reason is reason
    assert isinstance(error, (CodedError, HostSetupError, PermissionError))


def test_refusal_survives_pickling() -> None:
    error = _error(Path("/h/review"))

    restored = pickle.loads(pickle.dumps(error))

    assert str(restored) == str(error)
    assert restored.code == REVIEW_NOT_PRIVATE_CODE
    assert (
        restored.guest_message()
        == "The host's review files need attention; ask the host to check them."
    )


def test_guest_message_has_no_path_and_no_command(tmp_path: Path) -> None:
    error = _error(tmp_path / HOME_NAME / "review")

    assert "Mike" in str(error)
    assert (
        error.guest_message()
        == "The host's review files need attention; ask the host to check them."
    )
    assert "chmod" not in error.guest_message()
    assert "/" not in error.guest_message()


def test_staged_folder_check_picks_the_reason_from_the_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "review"
    folder.mkdir(mode=0o700)
    folder.chmod(0o755)
    review_versions._require_trusted_dir(os.stat(folder), folder)
    with pytest.raises(ReviewPrivacyError) as mode:
        review_versions._require_trusted_dir(os.stat(folder), folder, private=True)
    assert mode.value.reason is ReviewPrivacyReason.STAGING_MODE
    monkeypatch.setattr(os, "geteuid", lambda: os.getuid() + 1)
    with pytest.raises(ReviewPrivacyError) as foreign:
        review_versions._require_trusted_dir(os.stat(folder), folder)
    assert foreign.value.reason is ReviewPrivacyReason.ARTIFACTS_OWNER


def _loose_review_root(minimal_project: Path, sample_wav: Path, monkeypatch) -> tuple[Path, Path]:
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    monkeypatch.setattr(
        review_versions.FFmpegEngine,
        "export_mp3",
        lambda self, wav, mp3, *, bitrate_kbps: mp3.write_bytes(b"encoded"),
    )
    root = art / "review"
    root.mkdir()
    root.chmod(0o777)
    return root, minimal_project


def _fix_message(root: Path) -> str:
    return (
        f"review artifacts folder {root.resolve()} must not be writable by group or others "
        f"but is mode 0777; run: chmod go-w {root.resolve()}"
    )


@requires_safe_failed_cleanup
def test_staging_names_the_folder_and_the_fix(minimal_project, sample_wav, monkeypatch) -> None:
    root, _ = _loose_review_root(minimal_project, sample_wav, monkeypatch)

    with pytest.raises(ReviewPrivacyError) as raised:
        stage_version(
            load_project(minimal_project),
            label="x",
            on_media_created=lambda path, identity: None,
            defaults=load_defaults(),
        )

    assert str(raised.value) == _fix_message(root)
    assert not list(root.glob(".staging-review-*"))


@requires_safe_failed_cleanup
def test_publication_names_the_folder_and_the_fix(minimal_project, sample_wav, monkeypatch) -> None:
    root, _ = _loose_review_root(minimal_project, sample_wav, monkeypatch)
    root.chmod(0o755)

    def loosen(path: Path, identity: object) -> None:
        root.chmod(0o777)

    with pytest.raises(ReviewPrivacyError) as raised:
        publish_version(
            load_project(minimal_project),
            label="x",
            on_media_created=loosen,
            defaults=load_defaults(),
        )

    assert str(raised.value) == _fix_message(root)
    assert raised.value.code == REVIEW_NOT_PRIVATE_CODE
    assert not list(root.glob(".staging-review-*"))


@requires_safe_failed_cleanup
def test_recovery_after_the_suggested_chmod(minimal_project, sample_wav, monkeypatch) -> None:
    root, _ = _loose_review_root(minimal_project, sample_wav, monkeypatch)
    project = load_project(minimal_project)
    with pytest.raises(ReviewPrivacyError):
        publish_version(project, label="x", defaults=load_defaults())

    root.chmod(0o755)

    assert publish_version(project, label="x", defaults=load_defaults()).label == "x"


@requires_safe_failed_cleanup
def test_cli_prints_one_line_without_a_traceback(minimal_project, sample_wav, monkeypatch) -> None:
    root, _ = _loose_review_root(minimal_project, sample_wav, monkeypatch)

    result = CliRunner().invoke(
        cli_app, ["review", "publish-version", "--project", str(minimal_project), "--label", "x"]
    )

    assert result.exit_code == 1
    assert result.stderr.strip() == (
        f"Error: {_fix_message(root)} (code {REVIEW_NOT_PRIVATE_CODE}) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    )
    assert "Traceback" not in result.output + result.stderr


@requires_safe_failed_cleanup
@pytest.mark.asyncio
async def test_owner_mcp_tool_returns_the_refusal(minimal_project, sample_wav, monkeypatch) -> None:
    root, _ = _loose_review_root(minimal_project, sample_wav, monkeypatch)

    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "publish_review_version_tool", {"project_path": str(minimal_project), "label": "x"}
        )

    assert result.is_error
    assert result.content[0].text == _fix_message(root)
    assert result.structured_content["error_code"] == REVIEW_NOT_PRIVATE_CODE


def _gui_app(path: Path) -> TestClient:
    app = FastAPI()
    app.add_exception_handler(HostSetupError, host_setup_exception_handler)

    @app.get("/refuse")
    def refuse() -> None:
        raise _error(path)

    return TestClient(app, raise_server_exceptions=False)


def test_gui_handler_gives_the_host_the_path_and_the_fix(tmp_path: Path) -> None:
    path = tmp_path / "review"

    response = _gui_app(path).get("/refuse")

    assert response.status_code == 500
    assert response.headers["X-Sharecut-Error-Code"] == REVIEW_NOT_PRIVATE_CODE
    assert response.json()["detail"] == str(_error(path))
    assert f"chmod go-w {path}" in response.json()["detail"]


def test_gui_handler_gives_a_relayed_guest_the_fixed_line(tmp_path: Path) -> None:
    response = _gui_app(tmp_path / HOME_NAME / "review").get(
        "/refuse", headers={RELAYED_REQUEST_HEADER: "1"}
    )

    assert response.status_code == 500
    assert response.headers["X-Sharecut-Error-Code"] == REVIEW_NOT_PRIVATE_CODE
    assert (
        response.json()["detail"]
        == "The host's review files need attention; ask the host to check them."
    )
    assert str(tmp_path) not in response.text


def test_remote_mcp_does_not_treat_it_as_a_capability_denial(tmp_path: Path) -> None:
    assert _capability_denial(_error(tmp_path / "review")) is None


def _surface_tool_refusal(error: ReviewPrivacyError) -> str:
    refusal = tool_refusal(error, for_guest=True)
    assert refusal is not None
    assert refusal.code == REVIEW_NOT_PRIVATE_CODE
    return refusal.message


def _surface_failure_detail(error: ReviewPrivacyError) -> str:
    return guest_failure_detail(error) or ""


def _surface_http(error: ReviewPrivacyError) -> str:
    failure = guest_http_error(error, logger=log, operation="probe")
    assert failure.status_code == 500
    assert failure.headers == {"X-Sharecut-Error-Code": REVIEW_NOT_PRIVATE_CODE}
    return json.dumps([failure.status_code, failure.detail, failure.headers])


def _surface_ws(error: ReviewPrivacyError) -> str:
    failure = guest_ws_error(error, logger=log, operation="probe")
    return json.dumps([failure.detail, failure.code, failure.close_reason])


def _surface_mcp_tool_failure(error: ReviewPrivacyError) -> str:
    response = _tool_failure(1, "probe", error)
    assert response["result"]["structuredContent"]["error_code"] == REVIEW_NOT_PRIVATE_CODE
    return json.dumps(response)


GUEST_SURFACES: dict[str, Callable[[ReviewPrivacyError], str]] = {
    "tool_refusal": _surface_tool_refusal,
    "guest_failure_detail": _surface_failure_detail,
    "guest_http_error": _surface_http,
    "guest_ws_error": _surface_ws,
    "remote_mcp_tool_failure": _surface_mcp_tool_failure,
}


@pytest.mark.parametrize("surface", sorted(GUEST_SURFACES))
@pytest.mark.parametrize("name", ["plain", "SENTINEL-PATH-'q' \"d\" $HOME", HOME_NAME])
def test_no_guest_surface_shows_the_path(surface: str, name: str, tmp_path: Path) -> None:
    shown = GUEST_SURFACES[surface](_error(tmp_path / name / "artifacts" / "review"))

    assert "The host's review files need attention; ask the host to check them." in shown
    assert str(tmp_path) not in shown
    assert name not in shown
    assert "chmod" not in shown
