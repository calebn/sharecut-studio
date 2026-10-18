from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.edits.bleed_restore_targets import (
    BleedRestoreChangedError,
    BleedRestoreTarget,
    late_source_regions,
    merged_restore_choice,
    region_fragments,
    selected_occurrence,
    state_digest,
)
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track
from podcast_mcp.models.episode import SourceSpan


def _clip() -> Clip:
    return Clip(id="one", track_id="host", source_start=2, source_end=8, timeline_start=10)


def _target(clip: Clip) -> BleedRestoreTarget:
    return BleedRestoreTarget(
        track_id="host",
        occurrence_kind="explicit",
        clip=clip,
        kind="late_gate",
        region=SourceSpan(start_s=3, end_s=7),
        media_seal="seal",
        source_sha256="a" * 64,
        dependencies_digest="dependencies",
        plan_digest="plan",
        expected_head_id="root",
    )


def test_target_detaches_full_opening_snapshot_and_rejects_extra_fields():
    clip = _clip()
    target = _target(clip)
    clip.source_start = 3
    assert target.clip.source_start == 2
    with pytest.raises(ValidationError):
        BleedRestoreTarget.model_validate({**target.model_dump(), "ledger": []})
    with pytest.raises(ValidationError):
        target.track_id = "other"
    for head in (None, "", 123):
        with pytest.raises(ValidationError):
            BleedRestoreTarget.model_validate({**target.model_dump(), "expected_head_id": head})


def test_partial_saved_coverage_produces_exact_distinct_fragments():
    clip = _clip()
    covered, available = region_fragments(
        clip,
        SourceSpan(start_s=1, end_s=9),
        [SourceSpan(start_s=3, end_s=5), SourceSpan(start_s=4, end_s=6)],
    )
    assert [(r.start_s, r.end_s) for r in covered] == [(3, 6)]
    assert [(r.start_s, r.end_s) for r in available] == [(2, 3), (6, 8)]
    assert [(r.start_s, r.end_s) for r in late_source_regions(clip, [(9, 12), (12, 14)])] == [
        (2, 4),
        (4, 6),
    ]


def test_choice_union_is_idempotent_and_new_content_replaces_old_choices():
    clip = _clip()
    first = SourceSpan(start_s=3, end_s=5)
    clip.bleed_restore = merged_restore_choice(clip, "a" * 64, first)
    assert merged_restore_choice(clip, "a" * 64, first) == clip.bleed_restore
    merged = merged_restore_choice(clip, "a" * 64, SourceSpan(start_s=4, end_s=7))
    assert [(r.start_s, r.end_s) for r in merged.regions] == [(3, 7)]
    replaced = merged_restore_choice(clip, "b" * 64, SourceSpan(start_s=6, end_s=7))
    assert [(r.start_s, r.end_s) for r in replaced.regions] == [(6, 7)]


def test_implicit_occurrence_is_narrow_and_read_only(tmp_path):
    project = EpisodeProject.create("implicit", str(tmp_path))
    project.tracks.append(
        Track(id="host", label="Host", media=MediaAsset(path="host.wav", duration_sec=8))
    )
    clip, kind = selected_occurrence(project, "clip_host_full", "host")
    assert kind == "implicit" and clip.source_end == 8
    assert project.clips == []
    for changed in ("timeline_empty", "unknown_duration", "explicit", "unknown_id"):
        candidate = project.model_copy(deep=True)
        clip_id = "clip_host_full"
        if changed == "timeline_empty":
            candidate.tracks[0].timeline_empty = True
        elif changed == "unknown_duration":
            candidate.tracks[0].media.duration_sec = None
        elif changed == "explicit":
            candidate.clips = [_clip()]
        else:
            clip_id = "unknown"
        with pytest.raises(BleedRestoreChangedError):
            selected_occurrence(candidate, clip_id, "host")


def test_digest_is_deterministic_and_covers_authoritative_values():
    assert state_digest({"a": 1, "b": 2}) == state_digest({"b": 2, "a": 1})
    assert state_digest({"a": 1}) != state_digest({"a": 2})
