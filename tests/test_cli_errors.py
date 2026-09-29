"""Domain errors print as one CLI line, not a raw traceback; PODCAST_DEBUG=1 escapes
that and shows the original traceback instead (#773). Merged into the root
BusyErrorGroup choke point (cli/busy.py) alongside the busy-lock handling (#488)."""

from __future__ import annotations

import typer
from typer.testing import CliRunner

from podcast_mcp.cli.busy import BusyErrorGroup
from podcast_mcp.cli.main import app

runner = CliRunner()


def _build_app() -> typer.Typer:
    demo = typer.Typer(cls=BusyErrorGroup)

    @demo.command("boom-value")
    def _boom_value() -> None:
        raise ValueError("bad input")

    @demo.command("boom-runtime")
    def _boom_runtime() -> None:
        raise RuntimeError("not ready yet")

    @demo.command("boom-bug")
    def _boom_bug() -> None:
        raise TypeError("programming error, not a domain condition")

    return demo


def test_value_error_prints_one_line_and_exits_1():
    result = runner.invoke(_build_app(), ["boom-value"])
    assert result.exit_code == 1
    assert result.stderr.strip() == "Error: bad input (set PODCAST_DEBUG=1 for the traceback)"


def test_runtime_error_prints_one_line_and_exits_1():
    result = runner.invoke(_build_app(), ["boom-runtime"])
    assert result.exit_code == 1
    assert (
        result.stderr.strip() == "Error: not ready yet (set PODCAST_DEBUG=1 for the traceback)"
    )


def test_unrelated_exception_types_are_not_swallowed():
    """A bug (TypeError, etc.) still propagates with its traceback, not a clean exit."""
    result = runner.invoke(_build_app(), ["boom-bug"])
    assert result.exit_code != 0
    assert isinstance(result.exception, TypeError)


def test_podcast_debug_env_var_reraises_instead_of_printing_one_line(monkeypatch):
    """PODCAST_DEBUG=1 is the escape hatch the one-line message points at."""
    monkeypatch.setenv("PODCAST_DEBUG", "1")
    result = runner.invoke(_build_app(), ["boom-value"])
    assert result.exit_code != 0
    assert isinstance(result.exception, ValueError)
    assert not (result.stderr or "").strip()


def test_podcast_debug_env_var_off_values_still_print_clean_error(monkeypatch):
    monkeypatch.setenv("PODCAST_DEBUG", "0")
    result = runner.invoke(_build_app(), ["boom-value"])
    assert result.exit_code == 1
    assert result.stderr.strip() == "Error: bad input (set PODCAST_DEBUG=1 for the traceback)"


def test_suggest_handoff_cut_without_track_or_speaker_prints_clean_error(tmp_path):
    """The issue's reproduction: help lists --track as optional; omitting both
    --track and --speaker used to end in a full Rich traceback."""
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"
    result = runner.invoke(
        app,
        [
            "edit",
            "suggest-handoff-cut",
            "--project",
            str(project),
            "--keep-left-end",
            "1.0",
            "--keep-right-start",
            "3.0",
        ],
    )
    assert result.exit_code == 1
    assert (
        result.stderr.strip()
        == "Error: track_id or speaker is required (set PODCAST_DEBUG=1 for the traceback)"
    )
    assert "Traceback" not in result.output


def test_suggest_handoff_cut_debug_env_var_shows_original_exception(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_DEBUG", "1")
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    project = ws / "episode.project.json"
    result = runner.invoke(
        app,
        [
            "edit",
            "suggest-handoff-cut",
            "--project",
            str(project),
            "--keep-left-end",
            "1.0",
            "--keep-right-start",
            "3.0",
        ],
    )
    assert result.exit_code != 0
    assert isinstance(result.exception, ValueError)
    assert str(result.exception) == "track_id or speaker is required"
