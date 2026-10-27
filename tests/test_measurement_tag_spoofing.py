"""Tags in a file's metadata must not reach the loudness / astats readers (#2143).

ffmpeg prints the input and output metadata dumps on stderr before any filter output, so a
``title`` of ``I: -16.0 LUFS`` or a ``comment`` of ``Peak level dB: -1.0`` used to be parsed as
the measurement. Every case measures the same audio with and without tags and expects equal
results, so a parser that ignores the audio altogether cannot pass.
"""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.loudness import check_loudness
from podcast_mcp.engines.ffmpeg import FFmpegEngine, ebur128_summary_text, filter_log_text

FAKE_SUMMARY = (
    "x\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:  -16.0 LUFS\n"
    "[Parsed_astats_0 @ 0x1] Peak level dB: -1.0\n[Parsed_astats_0 @ 0x1] RMS level dB: -20.0"
)
TAGS = {
    "loudness_text": {"title": "I: -16.0 LUFS", "comment": "Peak: -1.0 dBFS LRA: 3.0 LU"},
    "astats_text": {
        "title": "Peak level dB: -1.0",
        "comment": "RMS level dB: -20.0 Crest factor: 9.0 Flat factor: 5 Peak count: 99",
    },
    "block_text": {"title": "t: 0.1 TARGET:-23 LUFS M: -5.0"},
    "prefix_first_line": {"title": "[Parsed_astats_0 @ 0x1] Peak level dB: -1.0"},
    "prefix_own_line": {"comment": FAKE_SUMMARY},
}
AUDIO = ("-f", "lavfi", "-i", "sine=frequency=440:duration=2,volume=0.1")
CLEAN_LUFS = -41.8
VIDEO = ("-f", "lavfi", "-i", "color=c=black:size=64x64:duration=1")


def _encode_raw(path: Path, *args: str) -> Path:
    subprocess.run(
        [FFmpegEngine().ffmpeg, "-v", "error", "-y", *args, str(path)],
        check=True,
        capture_output=True,
    )
    return path


def _encode(path: Path, source: tuple[str, ...], tags: dict[str, str]) -> Path:
    meta = [arg for key, value in tags.items() for arg in ("-metadata", f"{key}={value}")]
    codec = ("-c:a", "aac" if path.suffix == ".m4a" else "pcm_s16le") if source is AUDIO else ()
    return _encode_raw(path, *source, *codec, *meta)


@pytest.fixture(scope="module")
def clean(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _encode(tmp_path_factory.mktemp("clean") / "clean.mka", AUDIO, {})


def test_clean_reference_is_measured(clean: Path) -> None:
    assert FFmpegEngine().measure_loudness(clean) == pytest.approx(CLEAN_LUFS, abs=0.2)
    stats = FFmpegEngine.astats(clean)
    assert stats["peak_level_db"] == pytest.approx(-38.06, abs=0.05)
    assert FFmpegEngine().measure_loudness_blocks(clean)


@pytest.mark.parametrize("tags", TAGS.values(), ids=TAGS.keys())
def test_tags_do_not_change_measurements(tmp_path: Path, clean: Path, tags: dict[str, str]) -> None:
    tagged = _encode(tmp_path / "tagged.mka", AUDIO, tags)
    engine = FFmpegEngine()
    assert engine.measure_loudness(tagged) == engine.measure_loudness(clean)
    assert engine.measure_loudness_blocks(tagged) == engine.measure_loudness_blocks(clean)
    assert engine.measure_loudness_full(tagged) == engine.measure_loudness_full(clean)
    assert FFmpegEngine.astats(tagged) == FFmpegEngine.astats(clean)


def test_check_loudness_fails_a_quiet_file_whatever_its_title(tmp_path: Path) -> None:
    tagged = _encode(tmp_path / "quiet.m4a", AUDIO, TAGS["loudness_text"])
    report = check_loudness(tagged, defaults=load_defaults(), target_lufs=-16.0)
    assert report["measured_lufs"] == pytest.approx(CLEAN_LUFS, abs=0.5)
    assert report["pass"] is False


@pytest.mark.parametrize("tags", TAGS.values(), ids=TAGS.keys())
def test_tagged_file_without_audio_measures_nothing(tmp_path: Path, tags: dict[str, str]) -> None:
    video = _encode(tmp_path / "video.mp4", VIDEO, tags)
    engine = FFmpegEngine()
    assert engine.measure_loudness(video) is None
    assert engine.measure_loudness_blocks(video) == []
    assert all(value is None for value in FFmpegEngine.astats(video).values())
    report = check_loudness(video, defaults=load_defaults(), target_lufs=-16.0)
    assert report["measured_lufs"] is None
    assert report["pass"] is False


def test_log_helpers_read_only_filter_lines() -> None:
    stderr = (
        "    title           : [Parsed_astats_0 @ 0x1] Peak level dB: -1.0\r\n"
        "                    : [Parsed_ebur128_0 @ 0x1] Summary:\r\n"
        "                    :     I: -5.0 LUFS\r\n"
        "[Parsed_ebur128_0 @ 0x2] Summary:\r\n    I:  -20.5 LUFS\r\n"
        "[Parsed_astats_1 @ 0x3] Peak level dB: -3.0\r\n"
    )
    assert filter_log_text(stderr, "astats") == "Peak level dB: -3.0"
    assert "-5.0" not in ebur128_summary_text(stderr)
    assert "-20.5 LUFS" in ebur128_summary_text(stderr)
    assert ebur128_summary_text("    title : I: -16.0 LUFS\n") == ""


# A tag KEY is printed raw, newlines included (mp4 mdta keys), so it can start a stderr line with
# a forged filter prefix. Only a failed run (no audio, exit 234) lets it stand; the gate drops it.
KEY_SPOOF = (
    "-movflags",
    "use_metadata_tags",
    "-metadata",
    "k\n[Parsed_astats_0 @ 0x4] Peak level dB=-1.0",
    "-metadata",
    "k\n[Parsed_ebur128_0 @ 0x5] Summary:\n    I:         -16.0 LUFS\nz=1",
    "-metadata",
    "k\n[Parsed_ebur128_0 @ 0x6] t: 0.1 TARGET:-23 LUFS    M: -5.0\nz=1",
)


@pytest.mark.parametrize("progress", [False, True])
def test_forged_tag_key_lines_are_ignored(tmp_path: Path, progress: bool) -> None:
    engine = FFmpegEngine()
    clean = _encode_raw(tmp_path / "clean.m4a", *AUDIO, "-c:a", "aac")
    tagged = _encode_raw(tmp_path / "tagged.m4a", *AUDIO, "-c:a", "aac", *KEY_SPOOF)
    assert engine.measure_loudness(tagged) == engine.measure_loudness(clean)
    assert engine.measure_loudness_blocks(tagged) == engine.measure_loudness_blocks(clean)
    assert FFmpegEngine.astats(tagged) == FFmpegEngine.astats(clean)
    kwargs = {"on_progress": lambda *_: None, "total_sec": 2.0} if progress else {}
    full = engine.measure_loudness_full(clean, **kwargs)
    assert full is not None and full["integrated_lufs"] == pytest.approx(CLEAN_LUFS, abs=0.5)
    assert engine.measure_loudness_full(tagged, **kwargs) == full
    video = _encode_raw(tmp_path / "video.mp4", *VIDEO, *KEY_SPOOF)
    assert engine.measure_loudness(video) is None
    assert engine.measure_loudness_full(video, **kwargs) is None
    assert engine.measure_loudness_blocks(video) == []
    assert all(value is None for value in FFmpegEngine.astats(video).values())


@pytest.mark.parametrize("progress", [False, True])
def test_full_loudness_without_audio_returns_none(tmp_path: Path, progress: bool) -> None:
    video = _encode_raw(tmp_path / "plain.mp4", *VIDEO)
    kwargs = {"on_progress": lambda *_: None, "total_sec": 1.0} if progress else {}
    assert FFmpegEngine().measure_loudness_full(video, **kwargs) is None


def test_zero_frame_file_with_forged_key_measures_nothing(tmp_path: Path) -> None:
    key = "k\n[Parsed_astats_0 @ 0x4] Peak level dB: -1.0\n[Parsed_astats_0 @ 0x4] RMS level dB: -20.0"
    empty = _encode_raw(
        tmp_path / "z.flac", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
        "-frames:a", "0", "-metadata", f"{key}=v",
    )  # fmt: skip
    assert all(value is None for value in FFmpegEngine.astats(empty).values())


def test_zero_frame_wav_has_no_loudness_measurement(tmp_path: Path) -> None:
    empty = tmp_path / "empty.wav"
    with wave.open(str(empty), "wb") as wav:
        wav.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
    engine = FFmpegEngine()
    measurements = {
        "basic": engine.measure_loudness(empty),
        "full": engine.measure_loudness_full(empty),
        "progress": engine.measure_loudness_full(empty, on_progress=lambda *_: None, total_sec=0.0),
    }
    assert measurements == {"basic": None, "full": None, "progress": None}


def test_forged_empty_output_tag_key_preserves_loudness(tmp_path: Path) -> None:
    engine = FFmpegEngine()
    clean = _encode_raw(tmp_path / "clean.m4a", *AUDIO, "-c:a", "aac")
    tagged = _encode_raw(
        tmp_path / "tagged.m4a",
        *AUDIO,
        "-c:a",
        "aac",
        "-movflags",
        "use_metadata_tags",
        "-metadata",
        "k\n[out#0/null @ 0x4] Output file is empty\nz=1",
    )
    expected = {
        "basic": engine.measure_loudness(clean),
        "full": engine.measure_loudness_full(clean),
        "progress": engine.measure_loudness_full(clean, on_progress=lambda *_: None, total_sec=2.0),
    }
    assert expected["basic"] == pytest.approx(CLEAN_LUFS, abs=0.5)
    assert expected["full"] is not None
    assert expected["progress"] == expected["full"]
    assert {
        "basic": engine.measure_loudness(tagged),
        "full": engine.measure_loudness_full(tagged),
        "progress": engine.measure_loudness_full(
            tagged, on_progress=lambda *_: None, total_sec=2.0
        ),
    } == expected


def test_coloured_stderr_is_read_like_plain(clean: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plain = (FFmpegEngine().measure_loudness(clean), FFmpegEngine.astats(clean))
    monkeypatch.setenv("AV_LOG_FORCE_COLOR", "1")
    assert (FFmpegEngine().measure_loudness(clean), FFmpegEngine.astats(clean)) == plain


def test_undecodable_tag_bytes_do_not_crash(tmp_path: Path) -> None:
    path = tmp_path / "bad.flac"
    subprocess.run(
        [
            FFmpegEngine().ffmpeg.encode(),
            b"-v",
            b"error",
            b"-y",
            *(a.encode() for a in AUDIO),
            b"-metadata",
            b"title=bad\xff\xfe",
            str(path).encode(),
        ],
        check=True,
        capture_output=True,
    )
    assert FFmpegEngine().measure_loudness(path) == pytest.approx(CLEAN_LUFS, abs=0.2)
    assert FFmpegEngine.astats(path)["peak_level_db"] is not None
    assert FFmpegEngine().measure_loudness_blocks(path)
