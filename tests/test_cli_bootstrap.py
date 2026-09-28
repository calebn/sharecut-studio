from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app

runner = CliRunner()


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))


def test_bootstrap_unknown_component_errors() -> None:
    result = runner.invoke(app, ["bootstrap", "--component", "bogus"])
    assert result.exit_code == 2
    assert "Unknown component" in result.stderr


def test_bootstrap_ffmpeg_skips_when_already_on_path() -> None:
    with patch("podcast_mcp.cli.setup_cmd.shutil.which", return_value="/usr/bin/ffmpeg"):
        result = runner.invoke(app, ["bootstrap", "--component", "ffmpeg"])
    assert result.exit_code == 0
    assert "already on system PATH" in result.stdout


def test_bootstrap_ffmpeg_reports_failure_without_static_ffmpeg() -> None:
    with (
        patch("podcast_mcp.cli.setup_cmd.shutil.which", return_value=None),
        patch(
            "podcast_mcp.cli.setup_cmd.bootstrap_ffmpeg",
            side_effect=ImportError("static-ffmpeg is required"),
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "ffmpeg"])
    assert result.exit_code == 1
    assert "static-ffmpeg is required" in result.stderr


def test_bootstrap_ffmpeg_success(tmp_path: Path) -> None:
    ffmpeg_path = tmp_path / "ffmpeg"
    ffprobe_path = tmp_path / "ffprobe"
    with (
        patch("podcast_mcp.cli.setup_cmd.shutil.which", return_value=None),
        patch(
            "podcast_mcp.cli.setup_cmd.bootstrap_ffmpeg",
            return_value=(ffmpeg_path, ffprobe_path),
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "ffmpeg"])
    assert result.exit_code == 0
    assert str(ffmpeg_path) in result.stdout


def test_bootstrap_whisper_success() -> None:
    with patch("faster_whisper.WhisperModel", return_value=MagicMock()):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 0
    assert "whisper model 'large-v3-turbo'" in result.stdout
    from podcast_mcp.whisper_models import read_whisper_model_pref

    assert read_whisper_model_pref() == "large-v3-turbo"


def test_bootstrap_whisper_model_flag() -> None:
    with patch("faster_whisper.WhisperModel", return_value=MagicMock()):
        result = runner.invoke(
            app,
            ["bootstrap", "--component", "whisper", "--whisper-model", "small.en"],
        )
    assert result.exit_code == 0
    assert "whisper model 'small.en'" in result.stdout
    from podcast_mcp.whisper_models import read_whisper_model_pref

    assert read_whisper_model_pref() == "small.en"


def test_bootstrap_whisper_model_unknown() -> None:
    result = runner.invoke(
        app,
        ["bootstrap", "--component", "whisper", "--whisper-model", "nope"],
    )
    assert result.exit_code == 2
    assert "Unknown Whisper model" in result.stderr


def test_bootstrap_whisper_import_failure() -> None:
    with patch.dict("sys.modules", {"faster_whisper": None}):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 1


def test_bootstrap_whisper_download_failure() -> None:
    with patch("faster_whisper.WhisperModel", side_effect=RuntimeError("network down")):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 1
    assert "network down" in result.stderr


def test_bootstrap_whisper_persist_failure_still_ok() -> None:
    with (
        patch("faster_whisper.WhisperModel", return_value=MagicMock()),
        patch(
            "podcast_mcp.whisper_models.persist_whisper_model",
            side_effect=OSError("disk full"),
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "whisper"])
    assert result.exit_code == 0
    assert "could not persist" in result.stderr


def test_bootstrap_rnnoise_success(tmp_path: Path) -> None:
    model = tmp_path / "model.rnnn"
    with patch("podcast_mcp.cli.setup_cmd.bootstrap_rnnoise_model", return_value=model):
        result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 0
    assert str(model) in result.stdout


def test_bootstrap_rnnoise_failure() -> None:
    with patch(
        "podcast_mcp.cli.setup_cmd.bootstrap_rnnoise_model",
        side_effect=RuntimeError("network down"),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "rnnoise"])
    assert result.exit_code == 1


def test_bootstrap_silero_vad_available() -> None:
    with (
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=True),
        patch("podcast_mcp.engines.vad_silero.model_path", return_value=Path("/fake/model.onnx")),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "silero-vad"])
    assert result.exit_code == 0
    assert "bundled with faster-whisper" in result.stdout


def test_bootstrap_silero_vad_unavailable() -> None:
    with patch("podcast_mcp.engines.vad_silero.is_available", return_value=False):
        result = runner.invoke(app, ["bootstrap", "--component", "silero-vad"])
    assert result.exit_code == 1


def test_bootstrap_all_runs_every_component(tmp_path: Path) -> None:
    with patch("podcast_mcp.cli.setup_cmd.shutil.which", return_value="/usr/bin/ffmpeg"):
        with patch("faster_whisper.WhisperModel", return_value=MagicMock()):
            with patch(
                "podcast_mcp.cli.setup_cmd.bootstrap_rnnoise_model",
                return_value=tmp_path / "model.rnnn",
            ):
                with patch("podcast_mcp.engines.vad_silero.is_available", return_value=True):
                    with patch(
                        "podcast_mcp.engines.vad_silero.model_path",
                        return_value=Path("/fake/model.onnx"),
                    ):
                        with patch("podcast_mcp.cli.setup_cmd.bootstrap_word_aligner") as wa:
                            result = runner.invoke(app, ["bootstrap"])
    assert result.exit_code == 0
    assert "Bootstrap complete." in result.stdout
    wa.assert_not_called()


def test_bootstrap_word_aligner_success() -> None:
    with (
        patch("podcast_mcp.cli.setup_cmd.word_aligner_is_cached", return_value=False),
        patch(
            "podcast_mcp.cli.setup_cmd.bootstrap_word_aligner",
            return_value={"ok": True, "model": "onnx-base", "path": "/x"},
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 0
    assert "[ok] word-aligner" in result.stdout


def test_bootstrap_word_aligner_skips_when_cached() -> None:
    with (
        patch("podcast_mcp.cli.setup_cmd.word_aligner_is_cached", return_value=True),
        patch("podcast_mcp.cli.setup_cmd.bootstrap_word_aligner") as bootstrap,
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 0
    assert "[skip] word-aligner" in result.stdout
    bootstrap.assert_not_called()


def test_bootstrap_word_aligner_upgrade_forces_download() -> None:
    with (
        patch("podcast_mcp.cli.setup_cmd.word_aligner_is_cached", return_value=True),
        patch(
            "podcast_mcp.cli.setup_cmd.bootstrap_word_aligner",
            return_value={"ok": True, "model": "onnx-base", "path": "/x"},
        ) as bootstrap,
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner", "--upgrade"])
    assert result.exit_code == 0
    bootstrap.assert_called_once_with(force=True)


def test_bootstrap_word_aligner_failure_exits_1() -> None:
    with (
        patch("podcast_mcp.cli.setup_cmd.word_aligner_is_cached", return_value=False),
        patch(
            "podcast_mcp.cli.setup_cmd.bootstrap_word_aligner",
            side_effect=RuntimeError("hub down"),
        ),
    ):
        result = runner.invoke(app, ["bootstrap", "--component", "word-aligner"])
    assert result.exit_code == 1
    assert "hub down" in result.stderr


def test_doctor_reports_rnnoise_and_silero_status() -> None:
    result = runner.invoke(app, ["doctor"])
    assert "rnnoise model" in result.stdout
    assert "silero-vad" in result.stdout


def test_bootstrap_whisper_cli_uses_shared_downloader() -> None:
    with patch(
        "podcast_mcp.cli.setup_cmd.bootstrap_whisper_model",
        return_value={
            "ok": True,
            "model": "small.en",
            "cache": "/tmp/cache",
            "persist_error": None,
        },
    ) as mocked:
        result = runner.invoke(
            app,
            ["bootstrap", "--component", "whisper", "--whisper-model", "small.en"],
        )
    assert result.exit_code == 0
    mocked.assert_called_once_with("small.en")
    assert "small.en" in result.stdout
