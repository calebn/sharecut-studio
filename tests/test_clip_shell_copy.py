from __future__ import annotations

import copy
import itertools
import math
import random

import pytest

from clip_copy_support import full_clip, shared_objects
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import speech_energy_guard
from podcast_mcp.edits.speech_energy_guard import _removal_cells
from podcast_mcp.edits.verdict_cache import _heard
from podcast_mcp.engines.clips_ops import (
    clip_clear_of_range,
    remove_timeline_range_from_clips,
    shell_copy_clip,
)
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.models.episode import ClipOffSpeakerMuteRegion

HELPER = "a Clip field was added or changed: make full_clip() set it and check shell_copy_clip"


def _bare() -> Clip:
    return Clip(id="c", track_id="t", source_start=0, source_end=4, timeline_start=1)


def _variants() -> dict[str, Clip]:
    return {
        "full": full_clip(),
        "bare": _bare(),
        "off_speaker_set_empty": Clip(
            id="c",
            track_id="t",
            source_start=0,
            source_end=4,
            timeline_start=1,
            off_speaker_mute_regions=[],
        ),
        "bleed_restore_set_none": Clip(
            id="c", track_id="t", source_start=0, source_end=4, timeline_start=1, bleed_restore=None
        ),
        "off_speaker_only": Clip(
            id="c",
            track_id="t",
            source_start=0,
            source_end=4,
            timeline_start=1,
            off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=1, end_s=2)],
        ),
    }


def _sets(clip: Clip) -> list[set[str]]:
    sets = [clip.model_fields_set]
    for region in [*clip.mute_regions, *clip.off_speaker_mute_regions]:
        sets.append(region.model_fields_set)
        if getattr(region, "fill", None) is not None:
            sets.append(region.fill.model_fields_set)
    if clip.bleed_restore is not None:
        sets.append(clip.bleed_restore.model_fields_set)
        sets.extend(r.model_fields_set for r in clip.bleed_restore.regions)
    return sets


def _same_as_deep(made: Clip, deep: Clip) -> None:
    assert made == deep
    assert _sets(made) == _sets(deep)
    assert made.model_dump() == deep.model_dump()
    assert made.model_dump(exclude_unset=True) == deep.model_dump(exclude_unset=True)
    assert made.model_dump_json() == deep.model_dump_json()
    assert _heard(made, -math.inf, math.inf) == _heard(deep, -math.inf, math.inf)


def test_full_clip_sets_every_field_to_a_non_default_value():
    clip = full_clip()
    assert clip.model_fields_set == set(Clip.model_fields), HELPER
    for name, field in Clip.model_fields.items():
        default = field.get_default(call_default_factory=True)
        assert getattr(clip, name) != default, f"{name}: {HELPER}"
    assert all(getattr(clip, name) for name in ("mute_regions", "off_speaker_mute_regions"))
    assert clip.bleed_restore is not None and clip.bleed_restore.regions
    assert any(region.fill is not None for region in clip.mute_regions)


def test_clip_has_no_private_attributes_extra_or_computed_fields():
    assert Clip.__private_attributes__ == {}, HELPER
    assert Clip.model_config.get("extra") != "allow", HELPER
    assert Clip.model_computed_fields == {}, HELPER


@pytest.mark.parametrize("name", list(_variants()))
def test_shell_copy_equals_a_deep_copy_on_every_observable(name: str):
    clip = _variants()[name]
    _same_as_deep(shell_copy_clip(clip), copy.deepcopy(clip))


@pytest.mark.parametrize("name", list(_variants()))
def test_shell_copy_shares_no_mutable_object_with_the_original(name: str):
    clip = _variants()[name]
    assert shared_objects(clip, shell_copy_clip(clip)) == []


def test_the_graph_walk_sees_a_shared_object():
    clip = full_clip()
    made = shell_copy_clip(clip)
    made.__dict__["bleed_restore"] = clip.bleed_restore
    assert shared_objects(clip, made)


def test_mutating_every_nested_part_of_the_copy_leaves_the_original_alone():
    clip = full_clip()
    before = clip.model_dump_json()
    made = shell_copy_clip(clip)
    made.mute_regions.append(made.mute_regions[0].model_copy())
    made.mute_regions[0].start_s = 0.1
    made.mute_regions[0].fill.start_s = 0.2
    made.off_speaker_mute_regions[0].end_s = 9.9
    made.off_speaker_mute_regions.clear()
    made.bleed_restore.regions[0].start_s = 0.3
    made.bleed_restore.regions.append(made.bleed_restore.regions[0])
    made.bleed_restore.source_sha256 = "b" * 64
    assert clip.model_dump_json() == before


@pytest.mark.parametrize("update", [{"timeline_start": 12.5}, {"fade_in_ms": 3}])
@pytest.mark.parametrize("name", ["full", "bare"])
def test_update_marks_the_same_fields_set_as_a_deep_copy(name: str, update: dict):
    clip = _variants()[name]
    _same_as_deep(shell_copy_clip(clip, update), clip.model_copy(deep=True, update=update))


def test_an_empty_list_the_clip_holds_is_a_new_list():
    clip = _bare()
    made = shell_copy_clip(clip)
    made.mute_regions.append(full_clip().mute_regions[0])
    assert clip.mute_regions == []


def test_cut_application_copies_clips_through_the_helper():
    from podcast_mcp.edits.cut_application import _timeline_copy

    project = EpisodeProject.create("t", "/tmp/t")
    project.clips = [full_clip(), _bare()]
    made = _timeline_copy(project.timeline)
    assert made.clips == project.clips
    assert shared_objects(project.timeline.clips, made.clips) == []
    assert shared_objects(project.timeline.tracks, made.tracks) == []


def test_ripple_gives_a_shifted_clip_its_own_nested_parts():
    clip = full_clip()
    out = remove_timeline_range_from_clips([clip], 0.0, 1.0, defaults=load_defaults())
    assert [c.timeline_start for c in out] == [clip.timeline_start - 1.0]
    assert shared_objects(clip, out[0]) == []
    deep = clip.model_copy(deep=True, update={"timeline_start": clip.timeline_start - 1.0})
    _same_as_deep(out[0], deep)


def test_clear_of_range_is_the_ripple_predicate_at_the_tolerance_edges():
    clip = Clip(id="c", track_id="t", source_start=0, source_end=2, timeline_start=10)
    for start, end, clear in [
        (12.0 - 0.9e-9, 15.0, True),
        (12.0 - 1.1e-9, 15.0, False),
        (5.0, 10.0 + 0.9e-9, True),
        (5.0, 10.0 + 1.1e-9, False),
    ]:
        assert clip_clear_of_range(clip, start, end) is clear, (start, end)


def _peer_project(clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("t", "/tmp/t")
    project.tracks = [
        Track(
            id="peer",
            label="peer",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/peer.wav", duration_sec=60, sample_rate=16_000, channels=1),
        )
    ]
    project.clips = clips
    project.timeline.duration_sec = 60
    return project


def test_removal_cells_keeps_the_bounds_the_ripple_gave_at_the_tolerance_edges(monkeypatch):
    rng = random.Random(2359)
    edges = [0.0, 1e-9, 0.9e-9, 1.1e-9, SPAN_EPS_S, -1e-9, -1.1e-9]
    defaults = load_defaults()
    for _ in range(60):
        cuts = sorted(rng.sample(range(2, 50), 2))
        cut = (float(cuts[0]) + rng.choice(edges), float(cuts[1]) + rng.choice(edges))
        pos, clips = 0.0, []
        for k in range(rng.randint(1, 6)):
            length = rng.choice([2.0, 3.0, 4.0])
            anchor = rng.choice([pos, cut[0] - length, cut[1], cut[0], cut[1] - length])
            start = max(0.0, anchor + rng.choice(edges))
            clips.append(
                Clip(
                    id=f"c{k}",
                    track_id="peer",
                    source_start=k * 5.0,
                    source_end=k * 5.0 + length,
                    timeline_start=start,
                )
            )
            pos = start + length
        clips.sort(key=lambda c: c.timeline_start)
        if any(a.timeline_end > b.timeline_start for a, b in itertools.pairwise(clips)):
            continue
        project = _peer_project(clips)
        snapshot = [c.model_dump_json() for c in clips]
        fast = _removal_cells(project, "peer", 0.0, 60.0, None, removal_span=cut, defaults=defaults)
        assert [c.model_dump_json() for c in clips] == snapshot
        monkeypatch.setattr(speech_energy_guard, "clip_clear_of_range", lambda *a: False)
        slow = _removal_cells(project, "peer", 0.0, 60.0, None, removal_span=cut, defaults=defaults)
        monkeypatch.undo()
        assert fast == slow, (cut, [(c.timeline_start, c.timeline_end) for c in clips])
