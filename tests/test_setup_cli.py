from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
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


def test_setup_prints_each_models_readiness_and_fix(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(
        "podcast_mcp.engines.models.registry.whisper_model_problem",
        lambda model, memoize=False: None,
    )
    result = runner.invoke(setup_app, ["setup"])
    assert result.exit_code == 0
    assert "  whisper: ready (transcription)" in result.stdout
    assert (
        "  rnnoise: missing (noise reduction, ~0.3 MB). Fix: podcast bootstrap --component rnnoise"
    ) in result.stdout
    assert (
        "  word-aligner: missing (precise word boundaries, ~360 MB). "
        "Fix: podcast bootstrap --component word-aligner"
    ) in result.stdout
    assert (
        "  speaker-ecapa: missing (speaker recognition and split, ~83 MB). "
        "Fix: podcast bootstrap --component speaker-ecapa"
    ) in result.stdout


def test_setup_shows_missing_override_hint_and_keeps_bootstrap_command(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_MCP_SPEAKER_ECAPA_MODEL", str(tmp_path / "missing.onnx"))

    result = runner.invoke(setup_app, ["setup"])

    assert result.exit_code == 0
    assert "PODCAST_MCP_SPEAKER_ECAPA_MODEL" in result.stdout
    assert "missing" in result.stdout
    assert "working ONNX file" in result.stdout
    assert "unset" in result.stdout
    assert "Fix: podcast bootstrap --component speaker-ecapa" in result.stdout


def test_setup_prints_the_hint_of_an_unsupported_model(tmp_path, monkeypatch):
    import hashlib

    from podcast_mcp.engines.models import load_probe, speaker_ecapa

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    real = speaker_ecapa.asset_entry
    sha = hashlib.sha256(b"pinned").hexdigest()
    monkeypatch.setattr(
        speaker_ecapa, "asset_entry", lambda asset_id: {**real(asset_id), "sha256": sha}
    )
    target = speaker_ecapa.speaker_ecapa_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"pinned")
    load_probe.record(target, "RuntimeError: unsupported opset 99")

    result = runner.invoke(setup_app, ["setup"])

    assert result.exit_code == 0
    assert "  speaker-ecapa: unsupported" in result.stdout
    assert "unsupported opset 99" in result.stdout


def test_setup_says_update_needed_for_a_pin_mismatch(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(
        "podcast_mcp.cli.setup_cmd.model_status",
        lambda model_id, variant=None: {
            "state": "update_needed" if model_id == "rnnoise" else "installed",
            "size": "~0.3 MB",
            "bootstrap": "podcast bootstrap --component rnnoise --upgrade",
        },
    )
    result = runner.invoke(setup_app, ["setup"])
    assert (
        "  rnnoise: update needed (noise reduction, ~0.3 MB). "
        "Fix: podcast bootstrap --component rnnoise --upgrade"
    ) in result.stdout
    assert "  whisper: ready (transcription)" in result.stdout


def test_setup_ffmpeg_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with patch(
        "podcast_mcp.cli.setup_cmd.FFmpegEngine.check_available",
        return_value=(False, "not found"),
    ):
        result = runner.invoke(setup_app, ["setup"])
    assert result.exit_code == 0
    assert "FFmpeg missing" in result.stderr
    assert "FFmpeg 9.0.2" in result.stderr
    assert "docs/setup.md" in result.stderr


@pytest.mark.parametrize("command", ["setup", "doctor"])
def test_setup_and_doctor_reject_missing_explicit_ffprobe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: str
) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    ffmpeg = tmp_path / "ffmpeg"
    import shutil

    from podcast_mcp.util.binaries import resolve_ffmpeg

    shutil.copy2(resolve_ffmpeg(), ffmpeg)
    ffmpeg.chmod(0o755)
    monkeypatch.setenv("PODCAST_MCP_FFMPEG", str(ffmpeg))
    monkeypatch.setenv("PODCAST_MCP_FFPROBE", str(tmp_path / "missing-ffprobe"))

    with patch("podcast_mcp.engines.ffmpeg.runtime.run") as run:
        result = runner.invoke(setup_app, [command])

    assert result.exit_code == (0 if command == "setup" else 1)
    assert "missing-ffprobe" in result.output
    run.assert_not_called()


def test_setup_whisper_model_persists(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    result = runner.invoke(setup_app, ["setup", "--whisper-model", "small.en"])
    assert result.exit_code == 0
    assert "Whisper model preference: small.en" in result.stdout
    from podcast_mcp.engines.models.whisper import read_whisper_model_pref

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


def test_setup_installed_build_without_repo_files(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    empty = tmp_path / "site-packages-parent"
    empty.mkdir()
    with (
        patch("podcast_mcp.cli.setup_cmd.repo_root", return_value=empty),
        patch(
            "podcast_mcp.cli.setup_cmd.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 9.0.2"),
        ),
    ):
        plain = runner.invoke(setup_app, ["setup"])
        linked = runner.invoke(setup_app, ["setup", "--global-skills"])

    assert plain.exit_code == 0
    assert '"command": "podcast-mcp"' in plain.output
    assert "mcp.json" not in plain.output
    assert linked.exit_code == 1
    assert "No skills to link" in linked.output
    assert not (tmp_path / "home" / ".agents").exists()


def test_doctor_command():
    result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code in (0, 1)


def test_doctor_all_passed(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with patch(
        "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
        return_value=(True, "ffmpeg 7.0"),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 0
    assert "All checks passed." in result.stdout


def test_doctor_warns_on_invalid_whisper_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_WHISPER_MODEL", "nope")
    with patch(
        "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
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
        "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
        return_value=(True, "ffmpeg 7.0"),
    ):
        result = runner.invoke(setup_app, ["doctor", "--project", str(minimal_project)])
    assert result.exit_code == 0
    assert "[ok] timebase host: max_drift=30.0s" in result.stdout


def test_doctor_ffmpeg_fail(tmp_path, monkeypatch):
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with patch(
        "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
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
            "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 7.0"),
        ),
        patch("podcast_mcp.services.support.doctor.os.access", return_value=False),
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
            "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
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
            "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 7.0"),
        ),
        patch("builtins.__import__", side_effect=fake_import),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 0
    assert "[warn] faster-whisper" in result.stderr


def _aligner_record(**fields):
    from podcast_mcp.engines.models.registry import model_spec

    spec = model_spec("word-aligner")

    def fake(model_id, variant=None, *, memoize=True, check_load=True):
        if model_id != "word-aligner":
            return {"id": model_id, "state": "installed"}
        return {"id": model_id, "label": spec.label, **fields}

    return fake


def _stub_doctor_ffmpeg():
    engine = MagicMock()
    engine.check_available.return_value = (True, "ffmpeg 9.0.2")
    engine.source = "test"
    return patch("podcast_mcp.services.support.doctor.FFmpegEngine", return_value=engine)


def _patch_model_record(fake):
    return patch.multiple("podcast_mcp.engines.models.registry", model_record=fake), patch(
        "podcast_mcp.services.support.doctor.model_record", fake, create=True
    )


def test_doctor_fails_on_word_aligner_pin_mismatch(tmp_path, monkeypatch):
    from podcast_mcp.engines.models.registry import model_spec

    label = model_spec("word-aligner").label
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    fake = _aligner_record(
        state="update_needed",
        hint="vocab.json sha256 abc does not match the pin. Run: podcast bootstrap "
        "--component word-aligner --upgrade",
        bootstrap="podcast bootstrap --component word-aligner --upgrade",
    )
    first, second = _patch_model_record(fake)
    with (
        _stub_doctor_ffmpeg(),
        first,
        second,
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 1
    assert f"[fail] {label}: " in result.stderr
    assert "--upgrade" in result.stderr


def test_doctor_word_aligner_not_downloaded_warns_with_the_fix(tmp_path, monkeypatch):
    from podcast_mcp.engines.models.registry import model_spec

    spec = model_spec("word-aligner")
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    fake = _aligner_record(state="missing", hint="long copy", bootstrap=spec.fix_command)
    first, second = _patch_model_record(fake)
    with (
        _stub_doctor_ffmpeg(),
        first,
        second,
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 0
    assert (
        f"[warn] {spec.label}: not downloaded (run `{spec.fix_command}`; needed for {spec.purpose})"
    ) in result.stderr


def test_doctor_fails_on_whisper_pin_mismatch(tmp_path, monkeypatch):
    from podcast_mcp.engines.models.whisper import WhisperPinMismatchError

    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    with (
        patch(
            "podcast_mcp.services.support.doctor.FFmpegEngine.check_available",
            return_value=(True, "ffmpeg 7.0"),
        ),
        patch(
            "podcast_mcp.services.support.doctor.whisper_model_problem",
            return_value=WhisperPinMismatchError(
                "large-v3-turbo", "model.bin sha256 abc does not match the pin"
            ),
        ),
    ):
        result = runner.invoke(setup_app, ["doctor"])
    assert result.exit_code == 1
    assert "[fail] whisper model large-v3-turbo" in result.stderr
    assert "--upgrade" in result.stderr
