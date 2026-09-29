"""Domain errors print as one CLI line, not a raw traceback; PODCAST_DEBUG=1 escapes
that and shows the original traceback instead (#773). Merged into the root
BusyErrorGroup choke point (cli/busy.py) alongside the busy-lock handling (#488)."""

from __future__ import annotations

import pytest
import typer
from typer.testing import CliRunner

from podcast_mcp.cli.busy import BusyErrorGroup, _debug_enabled
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

    @demo.command("boom-not-implemented")
    def _boom_not_implemented() -> None:
        raise NotImplementedError("todo")

    @demo.command("boom-recursion")
    def _boom_recursion() -> None:
        raise RecursionError("maximum recursion depth exceeded")

    return demo


def test_value_error_prints_one_line_and_exits_1():
    result = runner.invoke(_build_app(), ["boom-value"])
    assert result.exit_code == 1
    assert result.stderr.strip() == "Error: bad input (set PODCAST_DEBUG=1 for the traceback)"


def test_runtime_error_prints_one_line_and_exits_1():
    result = runner.invoke(_build_app(), ["boom-runtime"])
    assert result.exit_code == 1
    assert result.stderr.strip() == "Error: not ready yet (set PODCAST_DEBUG=1 for the traceback)"


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


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON"])
def test_debug_enabled_accepts_true_values(monkeypatch, value):
    monkeypatch.setenv("PODCAST_DEBUG", value)
    assert _debug_enabled() is True


@pytest.mark.parametrize(
    "value", ["0", "false", "False", "no", "NO", "off", "OFF", "nope", "2", ""]
)
def test_debug_enabled_rejects_everything_else(monkeypatch, value):
    """no/off/nope/etc. must stay off, not fall through to "anything but 0/false" (#773)."""
    monkeypatch.setenv("PODCAST_DEBUG", value)
    assert _debug_enabled() is False


def test_debug_enabled_defaults_to_false_when_unset(monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    assert _debug_enabled() is False


def test_not_implemented_error_is_never_swallowed(monkeypatch):
    """Nothing in src/podcast_mcp raises NotImplementedError as a domain guard, so it
    always tracebacks, debug flag or not."""
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    result = runner.invoke(_build_app(), ["boom-not-implemented"])
    assert result.exit_code != 0
    assert isinstance(result.exception, NotImplementedError)


def test_recursion_error_is_never_swallowed(monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    result = runner.invoke(_build_app(), ["boom-recursion"])
    assert result.exit_code != 0
    assert isinstance(result.exception, RecursionError)


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
