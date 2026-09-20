"""Unit tests for the podcast tunnel CLI command."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from podcast_mcp.cli.main import app

runner = CliRunner()


def test_tunnel_help():
    result = runner.invoke(app, ["tunnel", "--help"])
    assert result.exit_code == 0
    assert "relay" in result.output.lower()


def test_tunnel_missing_websockets_import_error(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")

    # Patch in the cli.tunnel namespace (where the name is bound after import)
    with patch(
        "podcast_mcp.cli.tunnel.run_tunnel_sync",
        side_effect=ImportError("no websockets"),
    ):
        result = runner.invoke(
            app,
            ["tunnel", "--project", str(proj), "--host-token", "tok"],
        )
    assert result.exit_code == 1
    assert "dependencies" in result.output.lower()


def test_tunnel_keyboard_interrupt_exits_cleanly(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")

    with patch(
        "podcast_mcp.cli.tunnel.run_tunnel_sync",
        side_effect=KeyboardInterrupt,
    ):
        result = runner.invoke(
            app,
            ["tunnel", "--project", str(proj)],
        )
    assert result.exit_code == 0
    assert "disconnected" in result.output.lower()


def test_tunnel_passes_options_to_run_tunnel_sync(tmp_path: Path):
    proj = tmp_path / "episode.project.json"
    proj.write_text("{}", encoding="utf-8")
    cfg_file = tmp_path / "relay.yaml"
    cfg_file.write_text("relay_url: ws://test/tunnel\n", encoding="utf-8")

    calls: list[dict] = []

    def fake_run(**kwargs):  # type: ignore[misc]
        calls.append(kwargs)

    with patch("podcast_mcp.cli.tunnel.run_tunnel_sync", fake_run):
        runner.invoke(
            app,
            [
                "tunnel",
                "--project",
                str(proj),
                "--relay-url",
                "ws://override/tunnel",
                "--host-token",
                "mytoken",
                "--public-base-url",
                "https://share.example.test",
                "--local-gui",
                "http://127.0.0.1:9999",
                "--config",
                str(cfg_file),
            ],
        )

    assert len(calls) == 1
    assert calls[0]["relay_url"] == "ws://override/tunnel"
    assert calls[0]["host_token"] == "mytoken"
    assert calls[0]["public_base_url"] == "https://share.example.test"
    assert calls[0]["local_gui_url"] == "http://127.0.0.1:9999"
    assert calls[0]["config_path"] == cfg_file
