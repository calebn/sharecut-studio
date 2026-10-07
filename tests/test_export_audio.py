from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.export.audio import (
    ExportFormatSpec,
    export_episode_audio,
    export_wav_enabled,
    resolve_export_formats,
    sanitize_export_stem,
    specs_from_extensions,
    write_audio_formats,
)
from podcast_mcp.export.names import MAX_EXPORT_STEM_BYTES
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.progress import CancelledProgress

PREVIOUS_EXPORT = {"ep.wav": b"OLD-WAV", "ep.mp3": b"OLD-MP3"}
MP3 = {"wav": True, "formats": [{"ext": "mp3", "codec": "libmp3lame", "bitrate_kbps": 128}]}


def _project_with_previous_export(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    project.export_dir().mkdir(parents=True, exist_ok=True)
    for name, data in PREVIOUS_EXPORT.items():
        (project.export_dir() / name).write_bytes(data)
    return project


def _export_listing(project: EpisodeProject) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(project.export_dir().iterdir())}


def _writes_output(*args, **_kwargs) -> Path:
    Path(args[1]).write_bytes(b"MP3")
    return Path(args[1])


def test_resolve_export_formats_legacy_mp3():
    specs = resolve_export_formats({"mp3_bitrate_kbps": 192})
    assert len(specs) == 1
    assert specs[0].ext == "mp3"
    assert specs[0].codec == "libmp3lame"
    assert specs[0].bitrate_kbps == 192


def test_resolve_export_formats_explicit_list():
    specs = resolve_export_formats(
        {
            "formats": [
                {"ext": "flac", "codec": "flac"},
                {"ext": "opus", "codec": "libopus", "bitrate_kbps": 96},
            ]
        }
    )
    assert [s.ext for s in specs] == ["flac", "opus"]
    assert specs[1].bitrate_kbps == 96


def test_resolve_export_formats_empty_list():
    assert resolve_export_formats({"formats": []}) == []


def test_export_format_spec_extra_args():
    spec = ExportFormatSpec.from_dict(
        {"ext": "aac", "codec": "aac", "extra_args": ["-movflags", "+faststart"]}
    )
    assert spec.extra_args == ("-movflags", "+faststart")


def test_export_format_spec_requires_ext():
    with pytest.raises(ValueError, match="ext"):
        ExportFormatSpec.from_dict({})


def test_export_wav_enabled_default():
    assert export_wav_enabled({}) is True
    assert export_wav_enabled({"wav": False}) is False


def test_specs_from_extensions_defaults_and_mp3():
    assert [s.ext for s in specs_from_extensions(None)] == ["wav"]
    specs = specs_from_extensions(["wav", "mp3"])
    assert specs[0].ext == "wav" and specs[0].codec is None
    assert specs[1].ext == "mp3" and specs[1].codec == "libmp3lame"
    assert specs[1].bitrate_kbps == 192


def test_write_audio_formats_wav_and_mp3(tmp_path: Path):
    source = tmp_path / "src.wav"
    source.write_bytes(b"RIFFSRC")
    eng = MagicMock()
    eng.export_audio.side_effect = lambda *a, **k: Path(a[1]).write_bytes(b"MP3")
    out_stem = tmp_path / "out" / "bounce"
    paths = write_audio_formats(
        eng,
        source,
        out_stem,
        specs_from_extensions(["wav", "mp3"]),
        metadata={"title": "t"},
    )
    assert len(paths) == 2
    assert (tmp_path / "out" / "bounce.wav").read_bytes() == b"RIFFSRC"
    assert eng.export_audio.called
    assert any(p.suffix == ".mp3" for p in paths)


def test_export_episode_audio_writes_wav_and_encoded(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"RIFF")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output
    paths = export_episode_audio(project, eng, mastered, MP3)
    assert paths == [tmp_path / "export" / "ep.wav", tmp_path / "export" / "ep.mp3"]
    assert _export_listing(project) == {"ep.mp3": b"MP3", "ep.wav": b"RIFF"}


def test_a_failed_encode_keeps_the_previous_export(tmp_path: Path):
    project = _project_with_previous_export(tmp_path)
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"NEW-WAV")
    eng = MagicMock()

    def fail(*args, **_kwargs):
        Path(args[1]).write_bytes(b"half an mp3")
        raise subprocess.CalledProcessError(1, ["ffmpeg"])

    eng.export_audio.side_effect = fail

    with pytest.raises(subprocess.CalledProcessError):
        export_episode_audio(project, eng, mastered, MP3)

    assert _export_listing(project) == PREVIOUS_EXPORT


def test_export_reaps_temps_a_crashed_export_left(tmp_path: Path):
    project = _project_with_previous_export(tmp_path)
    (project.export_dir() / f"ep.4242.{'a' * 32}.partial.mp3").write_bytes(b"orphan")
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"NEW-WAV")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output

    export_episode_audio(project, eng, mastered, MP3)

    assert _export_listing(project) == {"ep.mp3": b"MP3", "ep.wav": b"NEW-WAV"}


@pytest.fixture
def long_master(tmp_path: Path) -> Path:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    return eng.generate_tone(tmp_path / "artifacts" / "mastered.wav", duration_sec=900)


def test_a_cancel_mid_encode_stops_ffmpeg_and_keeps_the_previous_export(
    tmp_path: Path, long_master: Path
):
    project = _project_with_previous_export(tmp_path)

    def encode_started() -> bool:
        return any(
            p.name.endswith(".partial.mp3") and p.stat().st_size > 0
            for p in project.export_dir().iterdir()
        )

    with pytest.raises(CancelledProgress, match="Encoding cancelled"):
        export_episode_audio(project, FFmpegEngine(), long_master, MP3, cancel_check=encode_started)

    assert _export_listing(project) == PREVIOUS_EXPORT


def test_a_cancellable_encode_reports_an_ffmpeg_failure(tmp_path: Path, long_master: Path):
    with pytest.raises(subprocess.CalledProcessError) as failed:
        FFmpegEngine().export_audio(
            long_master, tmp_path / "out.mp3", codec="no-such-codec", cancel_check=lambda: False
        )
    assert b"no-such-codec" in failed.value.stderr


def test_sanitize_export_stem():
    assert sanitize_export_stem("My Episode: Part 1/2") == "My_Episode_Part_1_2"
    assert sanitize_export_stem("normal-name") == "normal-name"
    assert sanitize_export_stem("Q&A") == "Q_A"
    assert sanitize_export_stem("") == "episode"
    assert sanitize_export_stem("///") == "episode"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        (".", "episode"),
        ("..", "episode"),
        (".release.", "release"),
        ("CON", "CON_file"),
        ("nul.txt", "nul_file.txt"),
        ("Lpt9", "Lpt9_file"),
    ],
)
def test_sanitize_export_stem_avoids_dot_paths_and_windows_devices(name: str, expected: str):
    assert sanitize_export_stem(name) == expected


def test_sanitize_export_stem_bounds_utf8_and_avoids_truncation_collisions():
    ascii_name = "a" * 500
    unicode_name = "é" * 500
    same_prefix_other_name = "a" * 499 + "b"

    ascii_stem = sanitize_export_stem(ascii_name)
    unicode_stem = sanitize_export_stem(unicode_name)
    other_stem = sanitize_export_stem(same_prefix_other_name)

    assert len(ascii_stem.encode("utf-8")) <= MAX_EXPORT_STEM_BYTES
    assert len(unicode_stem.encode("utf-8")) <= MAX_EXPORT_STEM_BYTES
    assert len(f"{unicode_stem}.chapters.json".encode()) <= 255
    assert ascii_stem == sanitize_export_stem(ascii_name)
    assert ascii_stem != other_stem
    assert ascii_stem.endswith("-" + hashlib.sha256(ascii_name.encode()).hexdigest()[:12])


def test_export_episode_audio_sanitizes_slash_in_name(tmp_path: Path):
    project = EpisodeProject.create("My Episode: Part 1/2", str(tmp_path))
    project.ensure_dirs()
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"RIFF")
    eng = MagicMock()
    export_cfg = {"wav": True, "formats": []}
    paths = export_episode_audio(project, eng, mastered, export_cfg)
    # single file directly under export/, no nested directories
    assert (tmp_path / "export" / "My_Episode_Part_1_2.wav").is_file()
    assert not (tmp_path / "export" / "My Episode: Part 1").exists()
    assert len(paths) == 1


@pytest.mark.parametrize(
    ("project_name", "filename"),
    [(".", "episode.wav"), ("../CON", "CON_file.wav")],
)
def test_export_episode_audio_keeps_dot_and_reserved_names_under_export(
    tmp_path: Path, project_name: str, filename: str
):
    project = EpisodeProject.create(project_name, str(tmp_path))
    project.ensure_dirs()
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"RIFF")

    paths = export_episode_audio(project, MagicMock(), mastered, {"wav": True, "formats": []})

    assert paths == [tmp_path / "export" / filename]
    assert paths[0].is_file()
    assert list((tmp_path / "export").iterdir()) == paths
