from __future__ import annotations

import json
import wave
from itertools import pairwise
from pathlib import Path
from types import ModuleType

import jsonschema
import pytest

from podcast_mcp.models import load_project
from script_loader import load_script

REPO = Path(__file__).resolve().parents[1]
SCHEMA = REPO / "schemas" / "episode.project.schema.json"


def _load_fixture_builder() -> ModuleType:
    return load_script("build_large_project_fixture")


def _assert_benchmark_shape(
    project_path: Path, *, duration: int, clip_count: int, utterance_count: int
) -> None:
    raw = json.loads(project_path.read_text(encoding="utf-8"))
    jsonschema.validate(instance=raw, schema=json.loads(SCHEMA.read_text(encoding="utf-8")))
    project = load_project(project_path)

    assert project.meta.name == "large-project benchmark (disposable)"
    assert project.meta.ingest_alignment is None
    assert project.render.last_completed_step is None
    assert project.render.pipeline_runs == []
    assert project.meta.created_at != "2026-05-23T08:13:47.933166+00:00"

    clips = project.timeline.clips
    words = [word for track in project.transcript_data.per_track for word in track.words]
    assert project.transcript_data.combined is not None
    utterances = project.transcript_data.combined.utterances
    assert len(clips) == clip_count
    assert len(words) == utterance_count
    assert len(utterances) == utterance_count
    assert {row.speaker for row in utterances} == {"reference", "guest"}
    assert all(left.speaker != right.speaker for left, right in pairwise(utterances))
    assert all(left.end <= right.start for left, right in pairwise(utterances))
    assert all(row.start < row.end for row in utterances)
    assert len({clip.id for clip in clips}) == len(clips)
    assert len({word.text for word in words}) == len(words)
    assert {clip.track_id for clip in clips} == {"reference", "guest"}
    assert {track.track_id for track in project.transcript_data.per_track} == {
        "reference",
        "guest",
    }
    assert all(
        track.media is not None and track.media.duration_sec == duration
        for track in project.timeline.tracks
    )
    for track_id in ("reference", "guest"):
        track_clips = [clip for clip in clips if clip.track_id == track_id]
        assert track_clips[0].source_start == 0
        assert track_clips[-1].source_end == duration
        assert all(clip.source_start < clip.source_end for clip in track_clips)
        assert all(left.source_end == right.source_start for left, right in pairwise(track_clips))
    assert max(word.end for word in words) <= duration

    workspace = project_path.parent
    for track_id in ("reference", "guest"):
        for folder in ("raw", "sources"):
            with wave.open(str(workspace / folder / f"{track_id}.wav")) as audio:
                assert audio.getframerate() == 48_000
                assert audio.getnframes() == duration * 48_000
        peaks = json.loads(
            (workspace / "artifacts" / "peaks" / f"{track_id}.json").read_text(encoding="utf-8")
        )
        assert peaks["source"] == str(workspace / "raw" / f"{track_id}.wav")
        assert peaks["peaks"] and set(peaks["peaks"]) == {0}
    assert [path.name for path in workspace.parent.iterdir()] == [workspace.name]


def test_large_project_fixture_has_distributed_unique_data(tmp_path):
    project_path = _load_fixture_builder().build_project(
        tmp_path / "large-project",
        duration=120,
        clip_count=40,
        utterance_count=101,
    )
    _assert_benchmark_shape(project_path, duration=120, clip_count=40, utterance_count=101)


def test_large_project_fixture_odd_count_alternates_to_the_last_turn(tmp_path):
    project_path = _load_fixture_builder().build_project(
        tmp_path / "odd", duration=10, clip_count=2, utterance_count=5
    )
    combined = load_project(project_path).transcript_data.combined
    assert combined is not None
    assert [row.speaker for row in combined.utterances] == [
        "reference",
        "guest",
        "reference",
        "guest",
        "reference",
    ]


@pytest.mark.e2e_real
def test_large_project_fixture_default_two_hour_shape(tmp_path):
    builder = _load_fixture_builder()
    project_path = builder.build_project(tmp_path / "large-project")
    _assert_benchmark_shape(
        project_path,
        duration=builder.DEFAULT_DURATION,
        clip_count=builder.DEFAULT_CLIPS,
        utterance_count=builder.DEFAULT_UTTERANCES,
    )


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"clip_count": 3}, "divisible"),
        ({"clip_count": 1}, "at least two"),
        ({"duration": 0}, "positive finite"),
        ({"duration": float("nan")}, "positive finite"),
        ({"duration": float("inf")}, "positive finite"),
        ({"duration": 50_000}, "too long"),
        ({"duration": 1, "clip_count": 2_000}, "too many clips"),
        ({"duration": 10, "utterance_count": 100_000}, "too many utterances"),
        ({"track_count": 1}, "at least 2"),
        ({"waveform": "loud"}, "waveform must be"),
        ({"clip_count": 4, "track_count": 3}, "divisible"),
    ],
)
def test_large_project_fixture_rejects_invalid_arguments(tmp_path, kwargs, match):
    with pytest.raises(ValueError, match=match):
        _load_fixture_builder().build_project(tmp_path / "invalid", **kwargs)
    assert list(tmp_path.iterdir()) == []


def test_large_project_fixture_refuses_committed_fixture_tree(tmp_path):
    builder = _load_fixture_builder()
    with pytest.raises(ValueError, match="refusing"):
        builder.build_project(builder.FIXTURES_ROOT / "large-project-should-not-exist")
    assert not (builder.FIXTURES_ROOT / "large-project-should-not-exist").exists()


def test_large_project_fixture_refuses_existing_output(tmp_path):
    (tmp_path / "exists").mkdir()
    with pytest.raises(FileExistsError):
        _load_fixture_builder().build_project(tmp_path / "exists")


def test_large_project_fixture_removes_staging_on_failure(tmp_path, monkeypatch):
    builder = _load_fixture_builder()

    def fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(builder, "write_silent_peaks", fail)
    with pytest.raises(OSError, match="disk full"):
        builder.build_project(tmp_path / "partial", duration=10, clip_count=2, utterance_count=2)
    assert list(tmp_path.iterdir()) == []


def _pyramids(workspace: Path) -> dict[str, Path]:
    return {
        path.name.split(".")[0]: path for path in (workspace / "artifacts" / "peaks").glob("*.wfpk")
    }


def test_large_project_fixture_extra_tracks_and_synthetic_waveforms(tmp_path):
    from podcast_mcp.engines.waveform_pyramid import read_bins, read_meta
    from podcast_mcp.services.waveform import media_index, waveform_status

    project_path = _load_fixture_builder().build_project(
        tmp_path / "wide", duration=30, clip_count=30, utterance_count=10, track_count=3
    )
    project = load_project(project_path)
    assert [t.id for t in project.timeline.tracks] == ["reference", "guest", "t2"]
    t2 = project.track_by_id("t2")
    assert t2 is not None and t2.media is not None and t2.media.duration_sec == 30
    assert sum(1 for clip in project.timeline.clips if clip.track_id == "t2") == 10
    assert {t.track_id for t in project.transcript_data.per_track} == {"reference", "guest"}

    pyramids = _pyramids(project_path.parent)
    assert set(pyramids) == {"track-reference", "track-guest", "track-t2"}
    for path in pyramids.values():
        meta = read_meta(path)
        assert meta.total_frames == 30 * 48_000
        assert any(read_bins(path, meta, 0, 0, meta.levels[0].bins))
    # The pyramids sit under the keys the viewer asks for, so status is ready at once.
    index = media_index(project_path)
    status = waveform_status(project_path, "raw")["media"]
    for ref in ("track:reference", "track:guest", "track:t2"):
        assert ref in index.refs
        assert status[ref]["status"] == "ready"


def test_large_project_fixture_silent_waveforms(tmp_path):
    from podcast_mcp.engines.waveform_pyramid import read_bins, read_meta

    project_path = _load_fixture_builder().build_project(
        tmp_path / "quiet", duration=10, clip_count=2, utterance_count=2, waveform="silent"
    )
    for path in _pyramids(project_path.parent).values():
        meta = read_meta(path)
        assert not any(read_bins(path, meta, 0, 0, meta.levels[0].bins))
