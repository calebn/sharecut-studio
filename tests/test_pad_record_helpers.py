"""Direct tests of the pad-record helpers the verdict key and the pause check share."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from podcast_mcp.edits.cut_placement import (
    is_pad_record,
    pad_sample_range,
    pad_sample_recording,
    pad_sample_well_formed,
)
from podcast_mcp.models import (
    AppliedEditRecord,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
)
from podcast_mcp.util.coded_error import CodedError

if TYPE_CHECKING:
    from pathlib import Path


def _record(operation: str, **params: Any) -> AppliedEditRecord:
    return AppliedEditRecord(id="r", applied_at="2026-01-01", operation=operation, params=params)


@pytest.mark.parametrize("operation", ["fill_with_room_tone", "insert_room_tone_pad"])
def test_a_pad_operation_is_a_pad_record(operation: str) -> None:
    assert is_pad_record(_record(operation))


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"replace_gap_sec": 0.001}, True),
        ({"replace_gap_sec": 1}, True),
        ({"replace_gap_sec": 0}, False),
        ({"replace_gap_sec": 0.0}, False),
        ({"replace_gap_sec": -0.5}, False),
        ({"replace_gap_sec": float("nan")}, False),
        ({"replace_gap_sec": float("inf")}, False),
        ({"replace_gap_sec": True}, False),
        ({"replace_gap_sec": "0.5"}, False),
        ({"replace_gap_sec": 0.5, "mute": True}, False),
        ({}, False),
    ],
)
def test_a_remove_is_a_pad_record_only_for_a_positive_finite_gap_that_is_not_a_mute(
    params: dict[str, Any], expected: bool
) -> None:
    assert is_pad_record(_record("remove", **params)) is expected


def _sample(**over: Any) -> dict[str, Any]:
    return {"track_id": "host", "source_id": None, "source_start": 1.0, "source_end": 2.0} | over


@pytest.mark.parametrize(
    ("sample", "expected"),
    [
        (_sample(), True),
        (_sample(source_id="src"), True),
        (_sample(track_id=""), False),
        (_sample(track_id=None), False),
        (_sample(track_id=7), False),
        (_sample(source_id=""), False),
        (_sample(source_id=7), False),
        ({"track_id": "host"}, False),
        ("host", False),
        (None, False),
        (["host"], False),
    ],
)
def test_a_pad_sample_must_name_a_non_empty_track_and_a_none_or_non_empty_source(
    sample: object, expected: bool
) -> None:
    assert pad_sample_well_formed(sample) is expected


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (0.0, 1.0, (0.0, 1.0)),
        (0, 1, (0, 1)),
        (1.5, 2.5, (1.5, 2.5)),
        (-1e-9, 1.0, None),
        (2.0, 2.0, None),
        (3.0, 2.0, None),
        (float("nan"), 2.0, None),
        (float("-inf"), 2.0, None),
        (1.0, float("nan"), None),
        (1.0, float("inf"), None),
        (True, 2.0, None),
        (1.0, True, None),
        ("1", 2.0, None),
        (1.0, None, None),
        (None, 2.0, None),
    ],
)
def test_a_pad_sample_range_is_the_finite_increasing_range_from_zero_up(
    start: object, end: object, expected: tuple[float, float] | None
) -> None:
    assert pad_sample_range(_sample(source_start=start, source_end=end)) == expected


def test_a_pad_sample_without_a_range_has_none() -> None:
    assert pad_sample_range({"track_id": "host", "source_id": None}) is None


def _project(root: Path) -> EpisodeProject:
    (root / "raw").mkdir(exist_ok=True)
    (root / "raw" / "host.wav").write_bytes(b"x")
    (root / "raw" / "alt.wav").write_bytes(b"x")
    project = EpisodeProject.create("helpers", str(root))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0, sample_rate=48000, channels=1),
        )
    ]
    project.sources = [
        SourceRecording(id="alt", path="raw/alt.wav", duration_sec=10.0),
        SourceRecording(id="gone", path="raw/gone.wav", duration_sec=10.0),
        SourceRecording(id="out", path="../outside.wav", duration_sec=10.0),
    ]
    return project


def test_a_pad_sample_recording_is_the_resolved_file_it_names(tmp_path: Path) -> None:
    project = _project(tmp_path)
    assert pad_sample_recording(project, _sample()) == (tmp_path / "raw" / "host.wav").resolve()
    alt = pad_sample_recording(project, _sample(source_id="alt"))
    assert alt == (tmp_path / "raw" / "alt.wav").resolve()


@pytest.mark.parametrize(
    ("over", "error"),
    [
        ({"track_id": "nobody"}, CodedError),
        ({"source_id": "nobody"}, CodedError),
        ({"source_id": "gone"}, OSError),
        ({"source_id": "out"}, ValueError),
    ],
    ids=["unknown_track", "unknown_source", "missing_file", "outside_workspace"],
)
def test_a_pad_sample_recording_that_does_not_resolve_raises(
    tmp_path: Path, over: dict[str, Any], error: type[Exception]
) -> None:
    with pytest.raises(error):
        pad_sample_recording(_project(tmp_path), _sample(**over))
