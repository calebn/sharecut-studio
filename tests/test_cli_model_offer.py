"""A CLI command that needs a missing model offers the download on a terminal (#2197)."""

from __future__ import annotations

import errno
import io
import sys
from collections.abc import Iterator
from dataclasses import replace

import pytest
import typer
from typer.testing import CliRunner

from podcast_mcp.cli import model_offer
from podcast_mcp.cli.main import app
from podcast_mcp.cli.progress import install_cli_progress
from podcast_mcp.engines.models import registry
from podcast_mcp.engines.models.registry import ModelProblem, model_spec, require_model
from podcast_mcp.util.asset_sources import DOWNLOAD_TASK_ID, DownloadProgress
from podcast_mcp.util.progress import (
    CliProgressReporter,
    RecordingProgress,
    clear_progress_sinks,
    register_progress_sink,
)

runner = CliRunner()
SPEAKER = model_spec("speaker-ecapa")
PROMPT = f"Download {SPEAKER.label} ({SPEAKER.size})? [y/N]:"
INSTALL_COMMAND = "podcast bootstrap --component speaker-ecapa"


class _Model:
    def __init__(self, problem: ModelProblem | None) -> None:
        self.problem = problem
        self.installs = 0
        self.error: BaseException | None = None

    def install(self, variant, force, on_progress):
        self.installs += 1
        if self.error is not None:
            raise self.error
        on_progress(DownloadProgress(40, 100))
        self.problem = None
        return {"ok": True, "path": "/models/ecapa.onnx"}


@pytest.fixture
def missing(monkeypatch: pytest.MonkeyPatch) -> _Model:
    model = _Model(ModelProblem("not downloaded", INSTALL_COMMAND))
    monkeypatch.setitem(
        registry._BY_ID,
        "speaker-ecapa",
        replace(SPEAKER, problem=lambda variant, memoize: model.problem, install=model.install),
    )
    return model


@pytest.fixture(autouse=True)
def _probe_command(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def probe_model() -> None:
        require_model("speaker-ecapa")
        typer.echo("ran")

    monkeypatch.setattr(app, "registered_commands", list(app.registered_commands))
    app.command("probe-model")(probe_model)
    install_cli_progress(app)
    yield
    clear_progress_sinks()


def _terminal(monkeypatch: pytest.MonkeyPatch, *, interactive: bool) -> None:
    monkeypatch.setattr(model_offer, "is_interactive", lambda: interactive)


def _refusal_line(stderr: str) -> str:
    lines = stderr.strip().splitlines()
    assert len(lines) == 1
    return lines[0]


def test_terminal_accept_downloads_with_bootstrap_progress_and_reruns(
    missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=True)
    rec = RecordingProgress()
    register_progress_sink(lambda: rec)

    result = runner.invoke(app, ["probe-model"], input="y\n")

    assert result.exit_code == 0
    assert PROMPT in result.stderr
    assert missing.installs == 1
    assert "[ok] speaker-ecapa: /models/ecapa.onnx" in result.stdout
    assert result.stdout.rstrip().endswith("ran")
    assert any(
        e.task_id == DOWNLOAD_TASK_ID and e.current == 40 for e in rec.events if e.kind == "update"
    )


@pytest.mark.parametrize("answer", ["n\n", "\n", ""])
def test_terminal_decline_keeps_the_command_unavailable(
    answer: str, missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=True)

    result = runner.invoke(app, ["probe-model"], input=answer)

    assert result.exit_code == 1
    assert PROMPT in result.stderr
    assert missing.installs == 0
    assert "ran" not in result.stdout
    assert f"needs {SPEAKER.label} ({SPEAKER.size}); run `{INSTALL_COMMAND}`" in result.stderr


def test_accepted_download_that_fails_keeps_the_install_command(
    missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=True)
    missing.error = OSError(errno.ENOSPC, "disk full")

    result = runner.invoke(app, ["probe-model"], input="y\n")

    assert result.exit_code == 1
    assert missing.installs == 1
    assert "[fail] speaker-ecapa:" in result.stderr
    assert f"run `{INSTALL_COMMAND}`" in result.stderr
    assert "ran" not in result.stdout


def test_non_terminal_prints_the_one_line_without_asking_or_downloading(
    missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=False)

    result = runner.invoke(app, ["probe-model"], input="y\n")

    assert result.exit_code == 1
    assert missing.installs == 0
    assert "Download" not in result.stderr + result.stdout
    assert _refusal_line(result.stderr).startswith(
        f"Error: needs {SPEAKER.label} ({SPEAKER.size}); run `{INSTALL_COMMAND}`"
    )


def test_no_input_on_a_terminal_prints_the_one_line_without_asking_or_downloading(
    missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=True)

    result = runner.invoke(app, ["--no-input", "probe-model"], input="y\n")

    assert result.exit_code == 1
    assert missing.installs == 0
    assert "Download" not in result.stderr + result.stdout
    assert _refusal_line(result.stderr).startswith(
        f"Error: needs {SPEAKER.label} ({SPEAKER.size}); run `{INSTALL_COMMAND}`"
    )


def test_no_input_does_not_leak_into_the_next_invocation(
    missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=True)
    runner.invoke(app, ["--no-input", "probe-model"])

    result = runner.invoke(app, ["probe-model"], input="y\n")

    assert result.exit_code == 0
    assert missing.installs == 1


def test_a_model_that_needs_an_upgrade_is_not_offered(
    missing: _Model, monkeypatch: pytest.MonkeyPatch
) -> None:
    _terminal(monkeypatch, interactive=True)
    missing.problem = ModelProblem("pin changed", f"{INSTALL_COMMAND} --upgrade", True)

    result = runner.invoke(app, ["probe-model"], input="y\n")

    assert result.exit_code == 1
    assert missing.installs == 0
    assert "Download" not in result.stderr


class _Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


def test_prompt_hides_the_live_bar_and_draws_it_again(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "stderr", _Tty())
    reporter = CliProgressReporter()
    try:
        reporter.start("download", "Downloading", total=10)
        live = reporter._progress.live
        assert live.is_started
        with reporter.paused():
            assert not live.is_started
        assert live.is_started
    finally:
        reporter.close()
