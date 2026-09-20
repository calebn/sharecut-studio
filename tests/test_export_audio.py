from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.export.audio import (
    ExportFormatSpec,
    export_episode_audio,
    export_wav_enabled,
    resolve_export_formats,
    sanitize_export_stem,
    specs_from_extensions,
    write_audio_formats,
)
from podcast_mcp.models import EpisodeProject


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
    export_cfg = {
        "wav": True,
        "formats": [{"ext": "mp3", "codec": "libmp3lame", "bitrate_kbps": 128}],
    }
    paths = export_episode_audio(project, eng, mastered, export_cfg)
    assert (tmp_path / "export" / "ep.wav").is_file()
    assert eng.export_audio.called
    assert len(paths) == 2


def test_sanitize_export_stem():
    assert sanitize_export_stem("My Episode: Part 1/2") == "My_Episode_Part_1_2"
    assert sanitize_export_stem("normal-name") == "normal-name"
    assert sanitize_export_stem("Q&A") == "Q_A"
    assert sanitize_export_stem("") == "episode"
    assert sanitize_export_stem("///") == "episode"


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
