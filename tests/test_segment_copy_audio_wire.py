from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from podcast_mcp.edits.segment_insert import SegmentAudio
from podcast_mcp.engines.ffmpeg.runtime import resolve_ffmpeg
from podcast_mcp.models import TrackRole
from podcast_mcp.segments.model import (
    MediaEntry,
    SegmentClip,
    SegmentFile,
    segment_id_for,
)
from podcast_mcp.segments.store import sha256_file
from podcast_mcp.services.document.segment_insert import copy_segment_audio
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok


def _flac(out: Path, seconds: float, frequency: int) -> Path:
    subprocess.run(
        [
            resolve_ffmpeg(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:duration={seconds}",
            "-ar",
            "48000",
            "-ac",
            "1",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    return out


def _segment(folder: Path, names: tuple[str, ...]) -> SegmentFile:
    folder.mkdir()
    clips, media = [], {}
    for index, name in enumerate(names, start=1):
        path = _flac(folder / name, 2.0, 300 + index * 110)
        clips.append(SegmentClip(audio=name, offset_sec=0.0, duration_sec=2.0, lane=index - 1))
        media[name] = MediaEntry(sha256=sha256_file(path), bytes=path.stat().st_size)
    return SegmentFile(
        id=segment_id_for("Copy Pin"),
        name="Copy Pin",
        kind="intro",
        role=TrackRole("intro"),
        fader_db=-3.0,
        clips=clips,
        media=media,
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    root.mkdir()
    return root


def test_the_copy_returns_one_entry_per_media_name_in_segment_order(tmp_path, workspace):
    segment = _segment(tmp_path / "lib", ("b-lane.flac", "a-lane.flac"))
    out = copy_segment_audio(workspace, segment, tmp_path / "lib")
    assert type(out) is dict
    assert list(out) == ["b-lane.flac", "a-lane.flac"]
    for name, entry in segment.media.items():
        digest = entry.sha256
        copy = out[name]
        assert type(copy) is SegmentAudio
        assert copy.source_id == f"seg_{digest}"
        assert copy.path == f"raw/segment-{digest}.flac"
        assert copy.duration_sec == pytest.approx(2.0, abs=0.05)
        assert (copy.sample_rate, copy.channels) == (48000, 1)
        assert type(copy.duration_sec) is float
        assert type(copy.sample_rate) is int
        assert type(copy.channels) is int
        assert sha256_file(workspace / copy.path) == digest


def test_the_copy_leaves_only_the_hash_named_files_in_raw(tmp_path, workspace):
    segment = _segment(tmp_path / "lib", ("one.flac", "two.flac"))
    copy_segment_audio(workspace, segment, tmp_path / "lib")
    names = sorted(p.name for p in (workspace / "raw").iterdir())
    assert names == sorted(f"segment-{e.sha256}.flac" for e in segment.media.values())


def test_copying_the_same_segment_twice_returns_equal_entries_and_stores_once(tmp_path, workspace):
    segment = _segment(tmp_path / "lib", ("one.flac",))
    first = copy_segment_audio(workspace, segment, tmp_path / "lib")
    second = copy_segment_audio(workspace, segment, tmp_path / "lib")
    assert first == second
    assert len(list((workspace / "raw").iterdir())) == 1


def test_a_changed_library_file_is_refused_with_the_hash_mismatch_code(tmp_path, workspace):
    segment = _segment(tmp_path / "lib", ("one.flac",))
    (tmp_path / "lib" / "one.flac").write_bytes(b"not the audio")
    with pytest.raises(CodedValueError) as raised:
        copy_segment_audio(workspace, segment, tmp_path / "lib")
    assert raised.value.code == "segment_hash_mismatch"
    assert str(raised.value) == (
        "The audio file one.flac of segment 'Copy Pin' does not match its recorded hash."
    )
    assert list((workspace / "raw").iterdir()) == []


def test_a_missing_library_file_is_a_write_failure_with_the_system_reason(tmp_path, workspace):
    segment = _segment(tmp_path / "lib", ("one.flac",))
    (tmp_path / "lib" / "one.flac").unlink()
    with pytest.raises(CodedValueError) as raised:
        copy_segment_audio(workspace, segment, tmp_path / "lib")
    assert raised.value.code == "segment_write_failed"
    assert str(raised.value) == (
        "The audio file one.flac of segment 'Copy Pin' could not be copied: "
        "No such file or directory."
    )
    assert list((workspace / "raw").iterdir()) == []


def test_a_segment_without_media_copies_nothing_and_returns_an_empty_dict(tmp_path, workspace):
    segment = _segment(tmp_path / "lib", ("one.flac",)).model_copy(update={"media": {}})
    out = copy_segment_audio(workspace, segment, tmp_path / "lib")
    assert out == {}
    assert type(out) is dict
    assert (workspace / "raw").is_dir()
