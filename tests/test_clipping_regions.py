"""Encoder clipping regions on recorded sources: model, helpers, list_clips, schema."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from podcast_mcp.edits.clipping_regions import (
    clip_clipping_payload,
    clipping_regions_from_ms,
)
from podcast_mcp.edits.timeline_ops import list_clips
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    ProjectMeta,
    SourceClippingRegion,
    SourceRecording,
)

ROOT = Path(__file__).resolve().parents[1]


def test_region_model_validates_order_and_bounds() -> None:
    assert SourceClippingRegion(start_s=0, end_s=0.5).end_s == 0.5
    for start, end in ((1, 1), (2, 1), (-0.1, 1), (0, float("nan"))):
        with pytest.raises(ValidationError):
            SourceClippingRegion(start_s=start, end_s=end)


def test_source_defaults_to_no_regions() -> None:
    assert SourceRecording(id="s", path="raw/s.wav").clipping_regions == []


def test_from_ms_clamps_to_the_file_and_drops_empties() -> None:
    out = clipping_regions_from_ms([[100, 250], [1900, 5000], [6000, 7000]], 2.0)
    assert [(r.start_s, r.end_s) for r in out] == [(0.1, 0.25), (1.9, 2.0)]
    assert clipping_regions_from_ms(None, 2.0) == []
    unbounded = clipping_regions_from_ms([[0, 10_000]], None)
    assert unbounded[0].end_s == 10.0


def _source() -> SourceRecording:
    return SourceRecording(
        id="rec-a-0-p_host-0",
        path="raw/a.wav",
        clipping_regions=[
            SourceClippingRegion(start_s=1.0, end_s=2.0),
            SourceClippingRegion(start_s=5.0, end_s=6.0),
        ],
    )


def test_clip_payload_intersects_and_sorts() -> None:
    assert clip_clipping_payload(None, 0, 10) == []
    assert clip_clipping_payload(_source(), 1.5, 5.5) == [
        {"start_s": 1.5, "end_s": 2.0},
        {"start_s": 5.0, "end_s": 5.5},
    ]
    assert clip_clipping_payload(_source(), 2.0, 5.0) == []


def _project(clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject(
        meta=ProjectMeta(name="t", workspace_dir="/tmp/t"), sources=[_source()]
    )
    project.clips = clips
    return project


def _clip(cid: str, start: float, end: float, at: float, source_id: str | None) -> Clip:
    return Clip(
        id=cid,
        track_id="t1",
        source_id=source_id,
        source_start=start,
        source_end=end,
        timeline_start=at,
    )


def test_list_clips_reports_regions_following_trims_and_splits() -> None:
    whole = _clip("a", 0.0, 10.0, 0.0, "rec-a-0-p_host-0")
    rows = list_clips(_project([whole]))["tracks"]["t1"]
    assert len(rows[0]["clipping_regions"]) == 2
    # After a split each half sees only its own span, wherever it moves.
    left = _clip("l", 0.0, 3.0, 0.0, "rec-a-0-p_host-0")
    right = _clip("r", 3.0, 10.0, 40.0, "rec-a-0-p_host-0")
    rows = {r["id"]: r for r in list_clips(_project([left, right]))["tracks"]["t1"]}
    assert rows["l"]["clipping_regions"] == [{"start_s": 1.0, "end_s": 2.0}]
    assert rows["r"]["clipping_regions"] == [{"start_s": 5.0, "end_s": 6.0}]
    trimmed = _clip("t", 1.5, 5.5, 0.0, "rec-a-0-p_host-0")
    row = list_clips(_project([trimmed]))["tracks"]["t1"][0]
    assert row["clipping_regions"] == [
        {"start_s": 1.5, "end_s": 2.0},
        {"start_s": 5.0, "end_s": 5.5},
    ]


def test_list_clips_has_no_regions_for_other_or_missing_sources() -> None:
    other = _clip("o", 0.0, 10.0, 0.0, "elsewhere")
    none = _clip("n", 0.0, 10.0, 20.0, None)
    rows = list_clips(_project([other, none]))["tracks"]["t1"]
    assert all(r["clipping_regions"] == [] for r in rows)


def test_episode_schema_accepts_the_field_and_round_trips() -> None:
    schema = json.loads((ROOT / "schemas" / "episode.project.schema.json").read_text())
    source_schema = {**schema["$defs"]["SourceRecording"], "$defs": schema["$defs"]}
    validator = Draft202012Validator(source_schema)
    payload = json.loads(_source().model_dump_json())
    validator.validate(payload)
    bad = {**payload, "clipping_regions": [{"start_s": -1}]}
    assert list(validator.iter_errors(bad))
    again = SourceRecording.model_validate(payload)
    assert again.clipping_regions == _source().clipping_regions
