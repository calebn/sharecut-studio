"""probe().duration_sec is where the first audio stream ends on the container timeline.

Expected values are the decoded truth of ``-map 0:a:0``. No libx264 here, so fixtures use
mpeg4/ffv1; ``.mkv`` is not an importable suffix for add-track, so those are copied to ``.m4a``.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines import ffmpeg as ffmpeg_module
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.track_media import media_asset_from_path

TOL = 0.05
_OUT_TIME = re.compile(r"out_time_us=(\d+)")
runner = CliRunner()


@pytest.fixture(scope="module")
def eng() -> FFmpegEngine:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    return engine


def _ff(eng: FFmpegEngine, *args: object) -> None:
    subprocess.run(
        [eng.ffmpeg, "-v", "error", "-y", *map(str, args)], check=True, capture_output=True
    )


def _video(seconds: float) -> list[str]:
    return ["-f", "lavfi", "-i", f"testsrc=size=64x64:rate=10:duration={seconds}"]


def _sine(seconds: float) -> list[str]:
    return ["-f", "lavfi", "-i", f"sine=f=440:r=44100:duration={seconds}"]


def decoded_extent(eng: FFmpegEngine, path: Path) -> float:
    """Decoded truth: last out_time_us of decoding ``0:a:0`` to the end."""
    result = subprocess.run(
        [
            eng.ffmpeg,
            "-v",
            "error",
            "-nostats",
            "-progress",
            "pipe:1",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(_OUT_TIME.findall(result.stdout)[-1]) / 1e6


def _av(eng, tmp_path, name, video_s, audio_s, *, vcodec="mpeg4", acodec="aac", offset=0.0):
    path = tmp_path / name
    audio_in = ["-itsoffset", offset, *_sine(audio_s)] if offset else _sine(audio_s)
    _ff(
        eng,
        *_video(video_s),
        *audio_in,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        vcodec,
        "-c:a",
        acodec,
        path,
    )
    return path


def _as_m4a(path: Path) -> Path:
    copy = path.with_name(path.stem + "_copy.m4a")
    shutil.copyfile(path, copy)
    return copy


def _cover_png(eng, tmp_path) -> Path:
    png = tmp_path / "cover.png"
    _ff(eng, "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", png)
    return png


def test_mp4_video_longer_than_audio_uses_audio_extent(eng, tmp_path):
    path = _av(eng, tmp_path, "vid5_aac2.mp4", 5, 2)
    truth = decoded_extent(eng, path)
    assert truth == pytest.approx(2.0, abs=TOL)
    assert eng.probe(path).duration_sec == pytest.approx(truth, abs=TOL)


def test_add_track_stores_audio_extent_everywhere(eng, tmp_path):
    src = _as_m4a(_av(eng, tmp_path, "vid5_aac2.mp4", 5, 2))
    truth = decoded_extent(eng, src)
    ws = tmp_path / "ep"
    assert runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "lab"]).exit_code == 0
    project = ws / "episode.project.json"
    result = runner.invoke(
        app,
        ["episode", "add-track", "--project", str(project), "--id", "t1", "--file", str(src)],
    )
    assert result.exit_code == 0, result.stdout
    doc = json.loads(project.read_text())
    media = doc["timeline"]["tracks"][0]["media"]["duration_sec"]
    source_end = doc["timeline"]["clips"][0]["source_end"]
    timeline = doc["timeline"]["duration_sec"]
    assert media == pytest.approx(truth, abs=TOL)
    assert source_end == pytest.approx(truth, abs=TOL)
    assert timeline == pytest.approx(truth, abs=TOL)


def test_matroska_without_stream_duration_uses_audio_extent(eng, tmp_path):
    path = _av(eng, tmp_path, "vid5_aac2.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    truth = decoded_extent(eng, path)
    assert truth == pytest.approx(2.0, abs=TOL)
    assert eng.probe(path).duration_sec == pytest.approx(truth, abs=TOL)
    # the importer path (copy named .m4a) agrees
    assert eng.probe(_as_m4a(path)).duration_sec == pytest.approx(truth, abs=TOL)


def test_matroska_piped_without_duration_uses_audio_extent(eng, tmp_path):
    """No Duration element, no cues: format.duration is a bitrate estimate (3.2 s for 2 s)."""
    path = tmp_path / "pipe_nodur.mkv"
    cmd = [
        eng.ffmpeg,
        "-v",
        "error",
        "-y",
        *_video(3),
        *_sine(2),
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "matroska",
        "-",
    ]
    with path.open("wb") as fh:
        subprocess.run(cmd, check=True, stdout=fh, stderr=subprocess.PIPE)
    truth = decoded_extent(eng, path)
    assert eng.probe(path).duration_sec == pytest.approx(truth, abs=TOL)


@pytest.mark.parametrize("container", ["mp4", "mkv"])
def test_late_audio_counts_leading_gap(eng, tmp_path, container):
    codec = ("mpeg4", "aac") if container == "mp4" else ("ffv1", "pcm_s16le")
    # video outlasts audio end (3 + 2 = 5 s) so format.duration cannot match by accident
    path = _av(eng, tmp_path, f"late.{container}", 8, 2, vcodec=codec[0], acodec=codec[1], offset=3)
    truth = decoded_extent(eng, path)
    assert truth == pytest.approx(5.0, abs=TOL)
    # a:0 duration alone (~2.02) is wrong: the renderer trims in container time, so the gap counts
    assert eng.probe(path).duration_sec == pytest.approx(truth, abs=TOL)


def test_late_audio_still_exports_its_samples(eng, tmp_path):
    src = _as_m4a(_av(eng, tmp_path, "late.mp4", 8, 2, offset=3))
    ws = tmp_path / "ep"
    assert runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "lab"]).exit_code == 0
    project = ws / "episode.project.json"
    args = ["--project", str(project)]
    assert (
        runner.invoke(
            app, ["episode", "add-track", *args, "--id", "t1", "--file", str(src)]
        ).exit_code
        == 0
    )
    assert runner.invoke(app, ["pipeline", "export-audio", *args]).exit_code == 0
    wav = ws / "artifacts" / "tracks" / "t1.wav"
    out = subprocess.run(
        [eng.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert float(out) == pytest.approx(2.0, abs=0.1)


def test_video_10_audio_6_uses_6(eng, tmp_path):
    path = _av(eng, tmp_path, "v10a6.mp4", 10, 6)
    assert eng.probe(path).duration_sec == pytest.approx(6.0, abs=TOL)


@pytest.mark.parametrize("suffix,codec", [("m4a", "aac"), ("mkv", "pcm_s16le")])
def test_audio_only_late_start_matches_decoded_length(eng, tmp_path, suffix, codec):
    path = tmp_path / f"offset.{suffix}"
    _ff(eng, "-itsoffset", 3, *_sine(2), "-c:a", codec, path)
    assert eng.probe(path).duration_sec == pytest.approx(decoded_extent(eng, path), abs=TOL)


def test_large_audio_only_container_origin_is_normalized_before_the_extent_bound(eng, tmp_path):
    path = tmp_path / "late-origin.mkv"
    _ff(eng, "-itsoffset", 700000, *_sine(2), "-c:a", "pcm_s16le", path)
    assert eng.probe(path).require_duration_sec() == pytest.approx(2, abs=TOL)


@pytest.mark.parametrize("video_s,audio_s", [(10, 6), (0, 2), (0, 10)])
def test_mpegts_matches_decoded_length(eng, tmp_path, video_s, audio_s):
    # the packet scan decides; AAC in TS still decodes ~0.09 s past its last packet
    path = tmp_path / "clip.ts"
    inputs = [*_video(video_s), *_sine(audio_s)] if video_s else _sine(audio_s)
    maps = ["-c:v", "mpeg2video", "-c:a", "aac"] if video_s else ["-c:a", "aac"]
    _ff(eng, *inputs, *maps, path)
    assert eng.probe(path).duration_sec == pytest.approx(decoded_extent(eng, path), abs=0.15)


@pytest.mark.parametrize("suffix,codec", [("ts", "aac"), ("ogg", "flac")])
def test_concatenated_audio_does_not_report_an_undercount_as_reliable(eng, tmp_path, suffix, codec):
    parts = []
    for index, seconds in enumerate((2, 3)):
        part = tmp_path / f"part{index}.{suffix}"
        _ff(eng, *_sine(seconds), "-c:a", codec, part)
        parts.append(part)
    path = tmp_path / f"joined.{suffix}"
    path.write_bytes(b"".join(part.read_bytes() for part in parts))
    decoded = subprocess.run(
        [
            eng.ffmpeg,
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    decoded_seconds = len(decoded.stdout) / (48000 * 2)
    assert decoded_seconds == pytest.approx(5.0, abs=0.15)

    info = eng.probe(path)

    assert info.duration_estimated or info.duration_sec == pytest.approx(decoded_seconds, abs=0.15)


def test_audio_only_m4a_unchanged(eng, tmp_path):
    path = tmp_path / "audio_only.m4a"
    _ff(eng, *_sine(2), "-c:a", "aac", path)
    assert eng.probe(path).duration_sec == pytest.approx(decoded_extent(eng, path), abs=TOL)


def test_ordinary_ogg_has_a_known_extent(eng, tmp_path):
    path = tmp_path / "single.ogg"
    _ff(eng, *_sine(2), "-c:a", "flac", path)
    assert eng.probe(path).require_duration_sec() == pytest.approx(2, abs=TOL)


def test_multistream_import_uses_known_first_audio_extent(eng, tmp_path):
    path = tmp_path / "multi.m4a"
    _ff(eng, *_sine(2), *_sine(3), "-map", "0:a", "-map", "1:a", "-c:a", "aac", path)
    info = eng.probe(path)
    assert info.audio_stream_count == 2
    assert info.require_duration_sec() == pytest.approx(2, abs=TOL)
    ws = tmp_path / "ep"
    assert (
        runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "multi"]).exit_code == 0
    )
    project = ws / "episode.project.json"
    result = runner.invoke(
        app, ["episode", "add-track", "--project", str(project), "--id", "t1", "--file", str(path)]
    )
    assert result.exit_code == 0, result.stdout
    doc = json.loads(project.read_text())
    assert doc["timeline"]["tracks"][0]["media"]["duration_sec"] == pytest.approx(2, abs=TOL)


@pytest.mark.parametrize("suffix,codec", [("m4a", "aac"), ("mp3", "libmp3lame")])
def test_cover_art_audio_unchanged(eng, tmp_path, suffix, codec):
    path = tmp_path / f"cover.{suffix}"
    png = _cover_png(eng, tmp_path)
    _ff(
        eng,
        *_sine(2),
        "-i",
        png,
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-c:a",
        codec,
        "-c:v",
        "mjpeg",
        "-disposition:v",
        "attached_pic",
        path,
    )
    assert eng.probe(path).duration_sec == pytest.approx(decoded_extent(eng, path), abs=TOL)


def test_mp3_without_xing_header_matches_decoded_length(eng, tmp_path):
    path = tmp_path / "noxing.mp3"
    _ff(eng, *_sine(7), "-c:a", "libmp3lame", "-write_xing", "0", path)
    assert eng.probe(path).duration_sec == pytest.approx(decoded_extent(eng, path), abs=TOL)


def test_file_without_audio_keeps_format_duration(eng, tmp_path):
    path = tmp_path / "silent.mp4"
    _ff(eng, *_video(3), "-c:v", "mpeg4", "-an", path)
    info = eng.probe(path)
    assert info.duration_sec == pytest.approx(3.0, abs=TOL)
    assert info.audio_stream_count == 0


def _patch_packet_scan(monkeypatch, *, stdout: str | None = None):
    """Answer the packet scan with *stdout*, or fail it when *stdout* is None."""
    real_popen = ffmpeg_module.popen
    calls = {"scan": 0}

    def fake_popen(cmd, *args, **kwargs):
        if "packet=pts_time,duration_time" not in cmd:
            return real_popen(cmd, *args, **kwargs)
        calls["scan"] += 1
        if stdout is None:
            raise OSError("packet scan unavailable")
        return SimpleNamespace(
            stdout=io.BytesIO(stdout.encode()), wait=lambda: 0, poll=lambda: 0, kill=lambda: None
        )

    monkeypatch.setattr(ffmpeg_module, "popen", fake_popen)
    return calls


def test_scan_failure_falls_back_to_format_duration(eng, tmp_path, monkeypatch):
    path = _av(eng, tmp_path, "scanfail.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    fmt = float(
        json.loads(
            subprocess.run(
                [eng.ffprobe, "-v", "error", "-print_format", "json", "-show_format", str(path)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )["format"]["duration"]
    )
    calls = _patch_packet_scan(monkeypatch)
    info = eng.probe(path)  # must not raise
    assert calls["scan"] == 1
    assert info.duration_estimated is True
    assert info.duration_sec == pytest.approx(fmt, abs=TOL)


def test_scan_failure_marks_result_estimated(eng, tmp_path, monkeypatch):
    path = _av(eng, tmp_path, "scanfail2.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    calls = _patch_packet_scan(monkeypatch)
    info = eng.probe(path)
    assert calls["scan"] >= 1, "probe() never attempted a packet scan for a stream without duration"
    assert info.duration_estimated is True


@pytest.mark.parametrize(
    "packets,expected",
    [
        ("0.0,1.0,\n1.0,1.0,\n2.0,0.5,\n", 2.5),  # side-data field leaves a trailing comma
        ("0.0,N/A\n1.0,N/A\n2.5,N/A\n", 2.5),  # a bad duration keeps its pts
        ("0.0,1.0\nnan,9\n1.0,inf\n", 1.0),  # non-finite fields are ignored
    ],
)
def test_packet_scan_parsing(eng, tmp_path, monkeypatch, packets, expected):
    path = _av(eng, tmp_path, "parse.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    _patch_packet_scan(monkeypatch, stdout=packets)
    info = eng.probe(path)
    assert info.duration_sec == pytest.approx(expected, abs=1e-6)
    assert info.duration_estimated is False


@pytest.mark.parametrize("packets", ["", "0.0,0\n", "garbage\n"])
def test_empty_packet_scan_counts_as_failed(eng, tmp_path, monkeypatch, packets):
    path = _av(eng, tmp_path, "empty.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    _patch_packet_scan(monkeypatch, stdout=packets)
    assert eng.probe(path).duration_estimated is True


def test_forged_packet_times_fail_the_scan(eng, tmp_path, monkeypatch):
    path = _av(eng, tmp_path, "forged.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    _patch_packet_scan(monkeypatch, stdout="0.0,1.0\n1.0,9000000000000000000\n")
    info = eng.probe(path)
    assert info.duration_estimated is True
    assert info.duration_sec <= 5.1


def test_short_container_duration_does_not_clip_the_scan(eng, tmp_path, monkeypatch):
    path = _av(eng, tmp_path, "stale.mkv", 5, 2, vcodec="ffv1", acodec="pcm_s16le")
    _patch_packet_scan(monkeypatch, stdout="0.0,1.0\n1.0,6.0\n")
    assert eng.probe(path).duration_sec == pytest.approx(7.0, abs=1e-6)


def test_estimated_container_duration_does_not_clamp_the_scan(eng, tmp_path):
    path = tmp_path / "loud_then_quiet.mp3"
    _ff(
        eng,
        "-f", "lavfi", "-i", "anoisesrc=d=2:r=44100:seed=1",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=18",
        "-filter_complex", "[0:a]aformat=channel_layouts=mono[a];[a][1:a]concat=n=2:v=0:a=1",
        "-c:a", "libmp3lame", "-q:a", "0", "-write_xing", "0", path,
    )  # fmt: skip
    info = eng.probe(path)
    assert info.duration_estimated is False
    assert info.audio_duration_sec is None
    assert info.duration_sec == pytest.approx(decoded_extent(eng, path), abs=0.1)
    assert media_asset_from_path(path, store_path="raw/no-xing.mp3").duration_sec == pytest.approx(
        info.duration_sec, abs=TOL
    )
