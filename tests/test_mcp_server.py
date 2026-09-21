"""Command-line dispatch tests for the stdio MCP entry point."""

from __future__ import annotations

from podcast_mcp import __version__
from podcast_mcp.mcp import server as mcp_server


def test_main_help_is_ascii_and_does_not_start_stdio(monkeypatch, capsys) -> None:
    monkeypatch.setattr(mcp_server.sys, "argv", ["podcast-mcp", "--help"])

    def unexpected_run(**_kwargs) -> None:
        raise AssertionError("help must not start the stdio server")

    monkeypatch.setattr(mcp_server.mcp, "run", unexpected_run)

    mcp_server.main()

    output = capsys.readouterr().out
    assert output.encode("ascii")
    assert "https://docs.sharecut.studio/#/mcp-setup" in output
    assert "Menu > Connect agent..." in output


def test_main_version_does_not_start_stdio(monkeypatch, capsys) -> None:
    monkeypatch.setattr(mcp_server.sys, "argv", ["podcast-mcp", "--version"])

    def unexpected_run(**_kwargs) -> None:
        raise AssertionError("version must not start the stdio server")

    monkeypatch.setattr(mcp_server.mcp, "run", unexpected_run)

    mcp_server.main()

    assert capsys.readouterr().out == f"podcast-mcp {__version__}\n"


def test_main_help_takes_precedence_over_version(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        mcp_server.sys,
        "argv",
        ["podcast-mcp", "--version", "--help"],
    )

    def unexpected_run(**_kwargs) -> None:
        raise AssertionError("help must not start the stdio server")

    monkeypatch.setattr(mcp_server.mcp, "run", unexpected_run)

    mcp_server.main()

    output = capsys.readouterr().out
    assert "Options:" in output
    assert output != f"podcast-mcp {__version__}\n"


def test_main_without_flags_starts_stdio(monkeypatch) -> None:
    monkeypatch.setattr(mcp_server.sys, "argv", ["podcast-mcp"])
    calls: list[dict[str, str]] = []

    def run(**kwargs: str) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(mcp_server.mcp, "run", run)

    mcp_server.main()

    assert calls == [{"transport": "stdio"}]
