from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.services.gui_launch import (
    PACKAGED_CLI_ENV,
    PACKAGED_CLI_GUI_REFUSAL,
    ensure_viewer,
    is_viewer_up,
    packaged_cli_gui_refusal,
    viewer_url,
)


def test_viewer_url_encodes_absolute_project(tmp_path: Path) -> None:
    from urllib.parse import parse_qs, unquote, urlparse

    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    url = viewer_url("127.0.0.1", 8765, proj)
    assert url.startswith("http://127.0.0.1:8765/?")
    qs = parse_qs(urlparse(url).query)
    assert unquote(qs["project"][0]) == str(proj.resolve())


def test_ensure_viewer_missing_project(tmp_path: Path) -> None:
    missing = tmp_path / "nope.json"
    result = ensure_viewer(missing, open_browser=False)
    assert result.ok is False
    assert "not found" in (result.error or "").lower()


def test_ensure_viewer_reuses_healthy_server(tmp_path: Path) -> None:
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=True),
        patch("podcast_mcp.services.gui_launch.webbrowser.open", return_value=True) as open_b,
    ):
        result = ensure_viewer(proj, open_browser=True)
    assert result.ok is True
    assert result.already_running is True
    assert result.opened_browser is True
    open_b.assert_called_once()


def test_ensure_viewer_port_busy_without_health(tmp_path: Path) -> None:
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=False),
        patch("podcast_mcp.services.gui_launch._port_in_use", return_value=True),
    ):
        result = ensure_viewer(proj, open_browser=False)
    assert result.ok is False
    assert "in use" in (result.error or "").lower()


def test_ensure_viewer_missing_uvicorn(tmp_path: Path) -> None:
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=False),
        patch("podcast_mcp.services.gui_launch._port_in_use", return_value=False),
        patch("podcast_mcp.gui.bind.gui_server_deps_available", return_value=False),
    ):
        result = ensure_viewer(proj, open_browser=False)
    assert result.ok is False
    assert "GUI dependencies" in (result.error or "")


def test_ensure_viewer_starts_subprocess(tmp_path: Path) -> None:
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    proc = MagicMock()
    proc.pid = 4242
    proc.poll.return_value = None

    health_calls = {"n": 0}

    def fake_health(host: str, port: int, *, timeout_sec: float = 0.4) -> bool:
        health_calls["n"] += 1
        return health_calls["n"] >= 2

    with (
        patch(
            "podcast_mcp.services.gui_launch.is_viewer_up",
            side_effect=fake_health,
        ),
        patch("podcast_mcp.services.gui_launch._port_in_use", return_value=False),
        patch("podcast_mcp.services.gui_launch.popen", return_value=proc) as popen,
        patch("podcast_mcp.services.gui_launch.webbrowser.open", return_value=True),
        patch("podcast_mcp.services.gui_launch.time.sleep"),
    ):
        result = ensure_viewer(proj, open_browser=True, wait_sec=2.0)

    assert result.ok is True
    assert result.already_running is False
    assert result.pid == 4242
    popen.assert_called_once()
    args = popen.call_args[0][0]
    assert "podcast_mcp.gui.serve" in args


def test_ensure_viewer_process_exits_early(tmp_path: Path) -> None:
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    proc = MagicMock()
    proc.pid = 7
    proc.poll.return_value = 1

    with (
        patch("podcast_mcp.services.gui_launch.is_viewer_up", return_value=False),
        patch("podcast_mcp.services.gui_launch._port_in_use", return_value=False),
        patch("podcast_mcp.services.gui_launch.popen", return_value=proc),
        patch("podcast_mcp.services.gui_launch.time.sleep"),
    ):
        result = ensure_viewer(proj, open_browser=False, wait_sec=1.0)
    assert result.ok is False
    assert "exited" in (result.error or "").lower()


def test_is_viewer_up_false_on_error() -> None:
    with patch(
        "podcast_mcp.services.gui_launch.urllib.request.urlopen",
        side_effect=OSError("down"),
    ):
        assert is_viewer_up("127.0.0.1", 9) is False


def test_is_viewer_up_sends_boot_token() -> None:
    class FakeResp:
        status = 200

        def read(self) -> bytes:
            return b'{"ok": true}'

        def __enter__(self) -> FakeResp:
            return self

        def __exit__(self, *args: object) -> None:
            return None

    seen: list[object] = []

    def fake_urlopen(req: object, timeout: float = 0.4) -> FakeResp:
        seen.append(req)
        return FakeResp()

    with (
        patch.dict("os.environ", {"PODCAST_SIDECAR_BOOT_TOKEN": "secret-token"}),
        patch("podcast_mcp.services.gui_launch.urllib.request.urlopen", fake_urlopen),
    ):
        assert is_viewer_up("127.0.0.1", 18765) is True
    req = seen[0]
    items = {k.lower(): v for k, v in req.header_items()}  # type: ignore[attr-defined]
    assert items.get("x-sharecut-boot-token") == "secret-token"


def test_open_gui_mcp_tool(tmp_path: Path) -> None:
    from podcast_mcp.mcp.server import open_gui_tool

    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    with patch(
        "podcast_mcp.mcp.tools.gui.ensure_viewer",
        return_value=MagicMock(
            to_json=lambda: json.dumps({"ok": True, "url": "http://x"}),
        ),
    ):
        out = open_gui_tool(str(proj), open_browser=False)
    assert json.loads(out)["ok"] is True


def test_gui_cli_background(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.gui import gui_app

    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    runner = CliRunner()
    payload = {"ok": True, "already_running": False}
    with patch(
        "podcast_mcp.cli.gui.ensure_viewer",
        return_value=MagicMock(ok=True, to_json=lambda: json.dumps(payload)),
    ):
        result = runner.invoke(
            gui_app,
            ["--project", str(proj), "--background", "--no-open"],
        )
    assert result.exit_code == 0
    assert json.loads(result.stdout)["ok"] is True


def test_packaged_cli_gui_refusal_only_when_marker_is_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(PACKAGED_CLI_ENV, raising=False)
    assert packaged_cli_gui_refusal() is None
    monkeypatch.setenv(PACKAGED_CLI_ENV, "0")
    assert packaged_cli_gui_refusal() is None
    monkeypatch.setenv(PACKAGED_CLI_ENV, "1")
    assert packaged_cli_gui_refusal() == PACKAGED_CLI_GUI_REFUSAL


def test_ensure_viewer_refuses_under_packaged_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    monkeypatch.setenv(PACKAGED_CLI_ENV, "1")
    with patch("podcast_mcp.services.gui_launch.popen") as spawn:
        result = ensure_viewer(proj, open_browser=False)
    assert result.ok is False
    assert result.error == PACKAGED_CLI_GUI_REFUSAL
    spawn.assert_not_called()


@pytest.mark.parametrize(
    "argv",
    [
        ["gui", "--no-open"],
        ["--no-progress", "gui", "--no-open"],
        ["--json-progress", "gui", "--background", "--project", "PROJECT"],
    ],
)
def test_packaged_cli_refuses_gui_after_root_options(
    argv: list[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    monkeypatch.setenv(PACKAGED_CLI_ENV, "1")
    argv = [str(proj) if a == "PROJECT" else a for a in argv]
    with (
        patch("podcast_mcp.cli.gui.ensure_viewer") as ensure,
        patch("podcast_mcp.gui.bind.run_gui_server") as serve,
    ):
        result = CliRunner().invoke(app, argv)
    assert result.exit_code == 2
    assert PACKAGED_CLI_GUI_REFUSAL in result.stderr
    ensure.assert_not_called()
    serve.assert_not_called()
