from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.export.audio import (
    M4A_AAC,
    ExportFormatSpec,
    export_wav_enabled,
    require_preset_encoder,
    resolve_export_formats,
    specs_from_extensions,
    write_audio_formats,
)
from podcast_mcp.export.chapters import render_chapters_json
from podcast_mcp.export.episode import export_episode_deliverables
from podcast_mcp.export.names import MAX_EXPORT_STEM_BYTES, sanitize_export_stem
from podcast_mcp.models import ChapterMarker, EpisodeProject
from podcast_mcp.util.progress import CancelledProgress

REPO_ROOT = Path(__file__).resolve().parents[1]
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
    paths = export_episode_deliverables(project, eng, mastered, {"export": MP3})
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
        export_episode_deliverables(project, eng, mastered, {"export": MP3})

    assert _export_listing(project) == PREVIOUS_EXPORT


def test_export_reaps_temps_a_crashed_export_left(tmp_path: Path):
    project = _project_with_previous_export(tmp_path)
    (project.export_dir() / f"ep.4242.{'a' * 32}.partial.mp3").write_bytes(b"orphan")
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"NEW-WAV")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output

    export_episode_deliverables(project, eng, mastered, {"export": MP3})

    assert _export_listing(project) == {"ep.mp3": b"MP3", "ep.wav": b"NEW-WAV"}


def test_chapters_json_matches_podcasting_2_golden_for_unsorted_markers_with_image():
    markers = [
        ChapterMarker(time=61.23456, title="Café ☕ 日本語", image_url="https://cdn.example/b.jpg"),
        ChapterMarker(time=0.1 + 0.2, title="Intro"),
        ChapterMarker(time=12.0, title="Middle"),
    ]
    assert render_chapters_json(markers) == (
        "{\n"
        '  "version": "1.2.0",\n'
        '  "chapters": [\n'
        "    {\n"
        '      "startTime": 0.3,\n'
        '      "title": "Intro"\n'
        "    },\n"
        "    {\n"
        '      "startTime": 12,\n'
        '      "title": "Middle"\n'
        "    },\n"
        "    {\n"
        '      "startTime": 61.235,\n'
        '      "title": "Café ☕ 日本語",\n'
        '      "img": "https://cdn.example/b.jpg"\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def test_chapters_json_for_no_chapters_is_an_empty_list():
    assert json.loads(render_chapters_json([])) == {"version": "1.2.0", "chapters": []}


def test_export_publishes_chapters_json_in_the_same_set_as_the_audio(tmp_path: Path):
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    project.chapters = [ChapterMarker(time=0.0, title="Start"), ChapterMarker(time=30.0, title="B")]
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"RIFF")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output

    paths = export_episode_deliverables(project, eng, mastered, {"export": MP3})

    chapters_path = tmp_path / "export" / "ep.chapters.json"
    assert chapters_path in paths
    assert json.loads(chapters_path.read_text("utf-8"))["chapters"] == [
        {"startTime": 0, "title": "Start"},
        {"startTime": 30, "title": "B"},
    ]


def test_a_failed_encode_keeps_the_previous_chapters_file(tmp_path: Path):
    project = _project_with_previous_export(tmp_path)
    old = project.export_dir() / "ep.chapters.json"
    old.write_text("OLD-CHAPTERS", encoding="utf-8")
    project.chapters = [ChapterMarker(time=5.0, title="New")]
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"NEW-WAV")
    eng = MagicMock()
    eng.export_audio.side_effect = subprocess.CalledProcessError(1, ["ffmpeg"])

    with pytest.raises(subprocess.CalledProcessError):
        export_episode_deliverables(project, eng, mastered, {"export": MP3})

    assert old.read_text("utf-8") == "OLD-CHAPTERS"


def test_a_project_without_chapters_writes_none_and_removes_a_stale_file(tmp_path: Path):
    project = _project_with_previous_export(tmp_path)
    stale = project.export_dir() / "ep.chapters.json"
    stale.write_text("OLD-CHAPTERS", encoding="utf-8")
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"NEW-WAV")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output

    paths = export_episode_deliverables(project, eng, mastered, {"export": MP3})

    assert stale not in paths
    assert _export_listing(project) == {"ep.mp3": b"MP3", "ep.wav": b"NEW-WAV"}


@pytest.mark.parametrize(
    ("chapters", "expected_prefix"),
    [
        (
            [ChapterMarker(time=0.0, title="A"), ChapterMarker(time=9.0, title="B")],
            "2 audio files, 2 chapters",
        ),
        ([], "2 audio files, "),
    ],
)
def test_the_export_step_summary_counts_audio_files_and_chapters_not_sidecars(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, chapters, expected_prefix
):
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.pipeline import steps

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    project.chapters = chapters
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"RIFF")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output
    monkeypatch.setattr(steps, "ensure_current_master", lambda *_a, **_k: mastered)
    monkeypatch.setattr(steps, "ffmpeg", lambda: eng)
    defaults = {**load_defaults(), "export": MP3}

    summary = steps.export_deliverables(project, defaults)

    assert summary.startswith(expected_prefix)
    assert summary.count("chapters") == (1 if chapters else 0)


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
        export_episode_deliverables(
            project, FFmpegEngine(), long_master, {"export": MP3}, cancel_check=encode_started
        )

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
    paths = export_episode_deliverables(project, eng, mastered, {"export": export_cfg})
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

    paths = export_episode_deliverables(
        project, MagicMock(), mastered, {"export": {"wav": True, "formats": []}}
    )

    assert paths == [tmp_path / "export" / filename]
    assert paths[0].is_file()
    assert list((tmp_path / "export").iterdir()) == paths


def test_a_bare_m4a_entry_expands_to_the_preset_and_a_detailed_one_does_not():
    assert specs_from_extensions(["m4a"]) == [M4A_AAC]
    assert ExportFormatSpec.from_dict({"ext": ".M4A"}) == M4A_AAC
    assert ExportFormatSpec.from_dict({"extension": "m4a"}) == M4A_AAC
    assert resolve_export_formats({"formats": [{"ext": "m4a"}]}) == [M4A_AAC]
    assert ExportFormatSpec.from_dict({"ext": "m4a", "codec": None, "extra_args": []}) == M4A_AAC
    custom = ExportFormatSpec.from_dict({"ext": "m4a", "codec": "alac"})
    assert custom != M4A_AAC and custom.codec == "alac"


def test_the_m4a_preset_matches_its_gui_contract():
    contract = json.loads((REPO_ROOT / "contracts" / "export-presets.json").read_text())
    assert ExportFormatSpec.from_dict(contract["m4a"]) == M4A_AAC


def test_a_build_without_the_preset_encoder_names_the_preset_before_encoding(tmp_path: Path):
    source = tmp_path / "src.wav"
    source.write_bytes(b"RIFFSRC")
    eng = MagicMock()
    eng.supports_encode.return_value = False
    stem = tmp_path / "out" / "ep"
    stem.parent.mkdir()
    (stem.parent / "ep.wav").write_bytes(b"OLD")
    with pytest.raises(ValueError, match=r"m4a export needs the aac encoder and ipod muxer"):
        write_audio_formats(eng, source, stem, specs_from_extensions(["wav", "m4a"]))
    eng.export_audio.assert_not_called()
    assert sorted(p.name for p in stem.parent.iterdir()) == ["ep.wav"]
    assert (stem.parent / "ep.wav").read_bytes() == b"OLD"


def test_an_unreadable_encoder_listing_is_not_reported_as_a_missing_encoder():
    eng = MagicMock()
    eng.supports_encode.return_value = None
    with pytest.raises(ValueError, match=r"could not read FFmpeg's encoder list"):
        require_preset_encoder(eng, M4A_AAC)


def test_a_custom_m4a_spec_is_checked_with_its_own_codec():
    eng = MagicMock()
    eng.supports_encode.return_value = True
    require_preset_encoder(eng, ExportFormatSpec(ext="m4a", codec="alac"))
    eng.supports_encode.assert_called_once_with("alac", "ipod")
    eng.supports_encode.reset_mock()
    require_preset_encoder(eng, ExportFormatSpec(ext="m4a", bitrate_kbps=96))
    eng.supports_encode.assert_called_once_with("aac", "ipod")
    other = MagicMock()
    require_preset_encoder(other, ExportFormatSpec(ext="mp3", codec="libmp3lame"))
    other.supports_encode.assert_not_called()


def _probe(ffprobe: str, path: Path) -> dict:
    out = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format_tags:stream=codec_name,profile,channels,sample_rate",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)


def _decoded_pcm_bytes(ffmpeg: str, path: Path) -> int:
    pcm = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-f", "s16le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return len(pcm)


@pytest.mark.parametrize("channels", [1, 2])
def test_the_m4a_preset_encodes_aac_lc_that_decodes_to_the_same_length(
    tmp_path: Path, channels: int
):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    source = tmp_path / "src.wav"
    subprocess.run(
        [
            eng.ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anoisesrc=d=3:c=pink:r=44100:a=0.3",
            "-ac",
            str(channels),
            str(source),
        ],
        check=True,
    )
    paths = write_audio_formats(
        eng,
        source,
        tmp_path / "out" / "ep",
        specs_from_extensions(["m4a"]),
        metadata={"title": "Ep", "album": "Show"},
    )
    assert [p.name for p in paths] == ["ep.m4a"]
    info = _probe(eng.ffprobe, paths[0])
    stream = info["streams"][0]
    assert (stream["codec_name"], stream["profile"]) == ("aac", "LC")
    assert (stream["channels"], stream["sample_rate"]) == (channels, "44100")
    tags = {k.lower(): v for k, v in info["format"]["tags"].items()}
    assert tags["major_brand"].strip() == "M4A"
    assert (tags["title"], tags["album"]) == ("Ep", "Show")
    assert _decoded_pcm_bytes(eng.ffmpeg, paths[0]) == _decoded_pcm_bytes(eng.ffmpeg, source)


def test_the_studio_export_publishes_chapters_through_the_same_exporter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from podcast_mcp.models import save_project
    from podcast_mcp.pipeline import steps
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.pipeline import PipelineService

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    project.chapters = [ChapterMarker(time=2.5, title="Cold open")]
    project_file = save_project(project)
    mastered = project.artifacts_dir() / "mastered.wav"
    mastered.write_bytes(b"RIFF")
    eng = MagicMock()
    eng.export_audio.side_effect = _writes_output
    monkeypatch.setattr(steps, "ensure_current_master", lambda *_a, **_k: mastered)
    monkeypatch.setattr(steps, "read_master_qc", lambda *_a, **_k: None)
    monkeypatch.setattr("podcast_mcp.services.pipeline.service.ffmpeg", lambda: eng)

    result = PipelineService(ProjectWorkspace.open(project_file)).export_audio()

    chapters_path = tmp_path / "export" / "ep.chapters.json"
    assert chapters_path in result.paths
    assert json.loads(chapters_path.read_text("utf-8"))["chapters"] == [
        {"startTime": 2.5, "title": "Cold open"}
    ]
