from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from podcast_mcp.cli.setup_cmd import _link_global_skills, setup_app
from podcast_mcp.models import load_project, save_project

runner = CliRunner()


def test_setup_command(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    result = runner.invoke(setup_app, ["setup"])
    assert result.exit_code == 0
    assert "Cache" in result.stdout or "FFmpeg" in result.stdout
    assert "MCP config" in result.stdout
    assert ".agents/mcp.json" in result.stdout


def test_setup_ffmpeg_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with patch(
        "podcast_mcp.cli.setup_cmd.FFmpegEngine.check_available",
        return_value=(False, "not found"),
    ):
        result = runner.invoke(setup_app, ["setup"])
    assert result.exit_code == 0
    assert "FFmpeg missing" in result.stderr
    assert "brew/apt install ffmpeg" in result.stderr
    assert "podcast bootstrap --component ffmpeg" in result.stderr


def test_setup_whisper_model_persists(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    result = runner.invoke(setup_app, ["setup", "--whisper-model", "small.en"])
    assert result.exit_code == 0
    assert "Whisper model preference: small.en" in result.stdout
    from podcast_mcp.whisper_models import read_whisper_model_pref

    assert read_whisper_model_pref() == "small.en"


def test_setup_whisper_model_rejects_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    result = runner.invoke(setup_app, ["setup", "--whisper-model", "nope"])
    assert result.exit_code == 2
    assert "Unknown Whisper model" in result.stderr


def test_link_global_skills(tmp_path, monkeypatch):
    src_root = tmp_path / "repo" / ".agents" / "skills"
    skill = src_root / "demo-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("demo", encoding="utf-8")
    (src_root / "README.md").write_text("not a skill dir", encoding="utf-8")

    dest_root = tmp_path / "home" / ".agents" / "skills"
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    with patch("podcast_mcp.cli.setup_cmd.repo_root", return_value=tmp_path / "repo"):
        _link_global_skills()

    dest = dest_root / "demo-skill"
    assert dest.is_symlink()
    assert dest.resolve() == skill.resolve()
    assert not (dest_root / "README.md").exists()

    with patch("podcast_mcp.cli.setup_cmd.repo_root", return_value=tmp_path / "repo"):
        _link_global_skills()
    assert dest.is_symlink()
    assert dest.resolve() == skill.resolve()


def test_doctor_command():
    result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code in (0, 1)


def test_doctor_all_passed(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with patch(
        "podcast_mcp.services.doctor.FFmpegEngine.check_available",
        return_value=(True, "ffmpeg 7.0"),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 0
    assert "All checks passed." in result.stdout


def test_doctor_warns_on_invalid_whisper_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "nope")
    with patch(
        "podcast_mcp.services.doctor.FFmpegEngine.check_available",
        return_value=(True, "ffmpeg 7.0"),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 0
    assert "Unknown Whisper model" in result.stderr


def test_doctor_with_project_reports_timebase(minimal_project, tmp_path, monkeypatch):
    from podcast_mcp.models import Clip

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    proj = load_project(minimal_project)
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=60.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=90.0,
            source_end=200.0,
            timeline_start=60.0,
        ),
    ]
    save_project(proj)
    with patch(
        "podcast_mcp.services.doctor.FFmpegEngine.check_available",
        return_value=(True, "ffmpeg 7.0"),
    ):
        result = runner.invoke(setup_app, ["doctor", "--project", str(minimal_project)])
    assert result.exit_code == 0
    assert "[ok] timebase host: max_drift=30.0s" in result.stdout


def test_doctor_ffmpeg_fail(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with patch(
        "podcast_mcp.services.doctor.FFmpegEngine.check_available",
        return_value=(False, "missing"),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 1
    assert "[fail] ffmpeg" in result.stderr


def test_doctor_cache_not_writable(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(cache))
    with (
        patch(
            "podcast_mcp.services.doctor.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 7.0"),
        ),
        patch("podcast_mcp.services.doctor.os.access", return_value=False),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 1
    assert "[fail] cache not writable" in result.stderr


def test_doctor_import_fail(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "podcast_mcp":
            raise ImportError("broken package")
        return real_import(name, *args, **kwargs)

    with (
        patch(
            "podcast_mcp.services.doctor.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 7.0"),
        ),
        patch("builtins.__import__", side_effect=fake_import),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 1
    assert "[fail] import" in result.stderr


def test_doctor_faster_whisper_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "faster_whisper":
            raise ImportError("not installed")
        return real_import(name, *args, **kwargs)

    with (
        patch(
            "podcast_mcp.services.doctor.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 7.0"),
        ),
        patch("builtins.__import__", side_effect=fake_import),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 0
    assert "[warn] faster-whisper" in result.stderr
