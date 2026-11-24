"""A pending padded cut plays the room tone it was bound to, whatever applies first (#3600)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import pad_binding
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.pad_binder import bind_pending_pad_picks
from podcast_mcp.edits.timeline_ops import LaneSample, room_tone_pad
from podcast_mcp.engines import room_tone
from podcast_mcp.engines.room_tone import OwnQuietSample, RecordedBedSample
from podcast_mcp.engines.room_tone_synth import SynthSample
from podcast_mcp.models import (
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    load_project,
    save_project,
)
from podcast_mcp.project.history.manager import snapshot_from_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from test_room_tone import (
    FLOOR_DB,
    SR,
    VOICE_DB,
    _add_voice,
    _noise,
    _project,
)
from test_room_tone_synth import _pick, _project_with_bed

DEFAULTS = load_defaults()
LENGTH_SEC = 40.0
# Two fillers that both sit next to one pooled sample: whichever applies first plays it.
FIRST, SECOND = "um-first", "um-second"
EARLY = "um-early"
CUTS = {FIRST: (20.4, 20.8), SECOND: (20.9, 21.2), EARLY: (4.0, 4.6)}


def _audio() -> np.ndarray:
    track = np.random.default_rng(77).normal(0.0, 10 ** (FLOOR_DB / 20), round(LENGTH_SEC * SR))
    for start, end in (*CUTS.values(), (4.0, 4.6), (12.0, 12.6), (28.0, 28.6), (35.0, 35.6)):
        _add_voice(track, start, end, VOICE_DB)
    return track


def _pending(edit_id: str, *, gap: float = 0.3) -> EditDecision:
    start, end = CUTS[edit_id]
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        boundary_mode="exact",
        review_required=False,
        applied=False,
        replace_gap_sec=gap,
        reason="filler:um",
    )


def _two_pending(tmp_path: Path) -> EpisodeProject:
    import test_room_tone

    test_room_tone.DURATION_SEC = LENGTH_SEC
    project = _project(tmp_path, host=_audio())
    test_room_tone.DURATION_SEC = 10.0
    project.transcripts = []
    project.clips[0].source_end = LENGTH_SEC
    track = project.track_by_id("host")
    assert track is not None and track.media is not None
    track.media.duration_sec = LENGTH_SEC
    room_tone.record_room_tone_pool(project, "host")
    project.edit_decisions = [_pending(FIRST), _pending(SECOND)]
    return project


def _approve(project: EpisodeProject, *ids: str) -> None:
    for edit_id in ids:
        approve_edits(
            project, [edit_id], defaults=DEFAULTS, application_intent=CutIntent.HUMAN_BOUNDARIES
        )


def _played(project: EpisodeProject) -> dict[str, tuple[float, float]]:
    """Source span each applied cut's pad plays on the host, by edit id."""
    played = {}
    for record in project.editorial.edit_log:
        samples = record.params.get("pad_samples") or []
        if samples and record.decision_ids:
            played[record.decision_ids[0]] = (
                round(samples[0]["source_start"], 6),
                round(samples[0]["source_end"], 6),
            )
    return played


def _tiles(project: EpisodeProject, edit_id: str) -> list[tuple[float, float]]:
    """Source span of each tile the cut's pad laid, in timeline order."""
    record = next(r for r in project.editorial.edit_log if r.decision_ids[:1] == [edit_id])
    return [
        (round(s["source_start"], 6), round(s["source_end"], 6))
        for s in record.params["pad_samples"]
    ]


def _bound_span(project: EpisodeProject, edit_id: str) -> tuple[float, float]:
    edit = next(e for e in project.edit_decisions if e.id == edit_id)
    assert edit.bound_pad is not None
    lane = edit.bound_pad.lanes["host"]
    return round(lane.start, 6), round(lane.end, 6)


def test_without_a_binding_the_pick_follows_what_applied_first(tmp_path: Path) -> None:
    one = _two_pending(tmp_path / "one")
    other = _two_pending(tmp_path / "other")

    _approve(one, FIRST, SECOND)
    _approve(other, SECOND, FIRST)

    assert _played(one)[FIRST] != _played(other)[FIRST]


def test_a_bound_cut_plays_the_same_pad_whatever_applied_before_it(tmp_path: Path) -> None:
    one = _two_pending(tmp_path / "one")
    other = _two_pending(tmp_path / "other")
    bind_pending_pad_picks(one, defaults=DEFAULTS)
    bind_pending_pad_picks(other, defaults=DEFAULTS)
    bound = {e: _bound_span(one, e) for e in (FIRST, SECOND)}

    _approve(one, FIRST, SECOND)
    _approve(other, SECOND, FIRST)

    assert _played(one) == _played(other) == bound


def test_a_bound_cut_does_not_replay_a_sample_a_neighbour_already_plays(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    project.edit_decisions = [_pending(FIRST)]
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    project.edit_decisions.append(_pending(SECOND))

    _approve(project, SECOND, FIRST)

    played = _played(project)
    first, second = played[FIRST], played[SECOND]
    assert first[1] <= second[0] or second[1] <= first[0]


def test_cuts_bound_together_play_different_samples(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)

    bind_pending_pad_picks(project, defaults=DEFAULTS)

    first, second = (_bound_span(project, e) for e in (FIRST, SECOND))
    assert first[1] <= second[0] or second[1] <= first[0]


def test_the_preview_copy_and_the_later_approve_play_one_pad(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    preview = project.model_copy(deep=True)

    _approve(preview, SECOND)
    _approve(project, FIRST, SECOND)

    assert _played(preview)[SECOND] == _played(project)[SECOND]


def test_the_suggested_preview_plays_the_pad_a_later_approve_lays(tmp_path: Path) -> None:
    from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
    from podcast_mcp.util.project_state import snapshot_project

    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    scratch = snapshot_project(project)

    apply_for_suggested(scratch, resolve_pending_preview(scratch, SECOND), defaults=DEFAULTS)
    _approve(project, FIRST, SECOND)

    assert _tiles(scratch, SECOND) == _tiles(project, SECOND)


def test_binding_twice_changes_nothing(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    assert bind_pending_pad_picks(project, defaults=DEFAULTS) == 2
    before = [e.bound_pad for e in project.edit_decisions]

    assert bind_pending_pad_picks(project, defaults=DEFAULTS) == 0

    assert [e.bound_pad for e in project.edit_decisions] == before


def test_a_cut_with_no_pad_has_no_binding(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    project.edit_decisions[0].replace_gap_sec = None

    bind_pending_pad_picks(project, defaults=DEFAULTS)

    assert project.edit_decisions[0].bound_pad is None
    assert project.edit_decisions[1].bound_pad is not None


def test_a_binding_does_not_survive_a_change_to_the_cut(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    edit = project.edit_decisions[1]
    stale = edit.bound_pad
    edit.replace_gap_sec = 0.5

    assert pad_binding.usable_lanes(edit) == {}
    bind_pending_pad_picks(project, defaults=DEFAULTS)

    assert edit.bound_pad is not None and edit.bound_pad != stale
    assert edit.bound_pad.geometry == pad_binding.geometry_key(edit)


def test_a_binding_made_for_another_cut_is_not_applied(tmp_path: Path) -> None:
    project = _two_pending(tmp_path / "bound")
    unbound = _two_pending(tmp_path / "unbound")
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    first, second = project.edit_decisions
    first.bound_pad = second.bound_pad

    assert pad_binding.usable_lanes(first) == {}
    _approve(project, FIRST)
    _approve(unbound, FIRST)

    assert _played(project)[FIRST] == _played(unbound)[FIRST]


def test_a_binding_clears_when_the_cut_no_longer_pads(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    project.edit_decisions[0].type = EditDecisionType.MUTE

    bind_pending_pad_picks(project, defaults=DEFAULTS)

    assert project.edit_decisions[0].bound_pad is None


def test_a_changed_pool_binds_again(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    edit = project.edit_decisions[0]
    lane = edit.bound_pad.lanes["host"]  # type: ignore[union-attr]
    assert lane.digest == pad_binding.lane_digest(project, "host")

    host = project.track_by_id("host")
    assert host is not None and host.media is not None
    import test_room_tone

    test_room_tone._write_wav(tmp_path / "raw" / "host.wav", _noise(-66.0, seed=5)[: 40 * SR])
    room_tone._POOLS.clear()

    assert pad_binding.lane_digest(project, "host") != lane.digest
    assert bind_pending_pad_picks(project, defaults=DEFAULTS) >= 1
    assert edit.bound_pad is not None
    assert edit.bound_pad.lanes["host"].digest == pad_binding.lane_digest(project, "host")


def test_a_bound_sample_a_pending_cut_now_plays_is_picked_again(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    second = next(e for e in project.edit_decisions if e.id == SECOND)
    held = _bound_span(project, SECOND)
    kept = pad_binding.usable_lanes(second)

    reused = room_tone_pad(project, 20.9, 0.3, avoid={}, bound=kept, defaults=DEFAULTS).lanes[0]
    refused = room_tone_pad(
        project, 20.9, 0.3, avoid={"host": [held]}, bound=kept, defaults=DEFAULTS
    ).lanes[0]

    assert isinstance(reused, LaneSample) and isinstance(refused, LaneSample)
    assert isinstance(reused.selection, OwnQuietSample)
    assert isinstance(refused.selection, OwnQuietSample)
    assert (reused.selection.sample.start, reused.selection.sample.end) == pytest.approx(held)
    assert refused.selection.sample.end <= held[0] or refused.selection.sample.start >= held[1]


def test_the_binding_is_saved_and_loaded_with_the_project(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    before = [e.bound_pad for e in project.edit_decisions]
    assert all(b is not None for b in before)

    loaded = load_project(save_project(project))

    assert [e.bound_pad for e in loaded.edit_decisions] == before
    raw = json.loads((tmp_path / "episode.sharecut").read_text(encoding="utf-8"))
    assert raw["editorial"]["edit_decisions"][0]["bound_pad"]["lanes"]["host"]["kind"] == "own"


def test_a_history_snapshot_keeps_the_binding(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)

    snapshot = snapshot_from_project(project)

    kept = snapshot.editorial["edit_decisions"]
    assert [d["bound_pad"] is not None for d in kept] == [True, True]


def test_a_pending_cut_with_no_binding_applies_and_picks_fresh(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    assert all(e.bound_pad is None for e in project.edit_decisions)

    _approve(project, FIRST, SECOND)

    assert set(_played(project)) == {FIRST, SECOND}
    assert project.edit_decisions == []


def test_the_same_pad_after_a_save_and_load_plays_the_same_fill(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    save_project(project)
    reloaded = load_project(tmp_path / "episode.sharecut")

    _approve(project, SECOND, FIRST)
    _approve(reloaded, FIRST, SECOND)

    assert _played(reloaded) == _played(project)


def _lane_of(project: EpisodeProject, selection, seed: float = 4.0) -> tuple:
    seam = pad_binding.PadSeam(4.0, None, 1.0, seed)
    lane = pad_binding.bound_lane(project, "host", selection, seam)
    return lane, seam


def test_a_bound_own_sample_is_rebuilt_and_refused_when_a_cut_still_plays_it(
    tmp_path: Path,
) -> None:
    project = _two_pending(tmp_path)
    own = room_tone.room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=1.0
    )
    assert isinstance(own, OwnQuietSample)
    lane, seam = _lane_of(project, own)

    assert pad_binding.reusable_selection(project, "host", lane, seam, []) == own
    start, end = own.sample.start, own.sample.end
    assert pad_binding.reusable_selection(project, "host", lane, seam, [(start, end)]) is None
    moved = pad_binding.PadSeam(4.5, None, 1.0, 4.0)
    assert pad_binding.reusable_selection(project, "host", lane, moved, []) is None
    longer = pad_binding.PadSeam(4.0, None, 2.0, 4.0)
    assert pad_binding.reusable_selection(project, "host", lane, longer, []) is None


def test_a_bound_bed_sample_is_rebuilt_while_the_bed_is_the_one_it_read(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, np.random.default_rng(7).normal(0, 1e-3, 8 * SR))
    bed = room_tone.room_tone_span(
        project, "host", near_sec=4.0, near_source_id=None, timeline_sec=4.0, duration_sec=1.0
    )
    assert isinstance(bed, RecordedBedSample)
    lane, seam = _lane_of(project, bed)

    assert lane.kind == "bed"
    assert pad_binding.reusable_selection(project, "host", lane, seam, []) == bed
    assert pad_binding.reusable_selection(project, "host", lane, seam, [(0.0, 99.0)]) == bed
    project.sources = [s for s in project.sources if s.id != "room-tone-host"]
    assert pad_binding.reusable_selection(project, "host", lane, seam, []) is None


def test_a_bound_synthesised_sample_is_rebuilt_while_its_file_exists(tmp_path: Path) -> None:
    project = _project_with_bed(tmp_path, np.random.default_rng(7).normal(0, 1e-3, 8 * SR))
    synth = _pick(project, 20.0)
    assert isinstance(synth, SynthSample)
    lane, seam = _lane_of(project, synth)

    assert lane.kind == "synth"
    assert pad_binding.reusable_selection(project, "host", lane, seam, []) == synth
    synth.path.unlink()
    assert pad_binding.reusable_selection(project, "host", lane, seam, []) is None


def test_a_cut_lays_the_same_tiles_whatever_moved_it_on_the_timeline(tmp_path: Path) -> None:
    long_pad = 3.0

    def tiles(order: list[str], *, bind: bool) -> list[tuple[float, float]]:
        project = _two_pending(tmp_path / f"{bind}-{len(order)}")
        project.edit_decisions = [
            _pending(EARLY, gap=long_pad),
            _pending(SECOND, gap=long_pad),
        ]
        if bind:
            bind_pending_pad_picks(project, defaults=DEFAULTS)
        _approve(project, *order)
        return _tiles(project, SECOND)

    assert tiles([EARLY, SECOND], bind=False) != tiles([SECOND], bind=False)
    assert tiles([EARLY, SECOND], bind=True) == tiles([SECOND], bind=True)


def test_a_reused_lane_keeps_the_seed_it_was_bound_with(tmp_path: Path) -> None:
    project = _two_pending(tmp_path)
    bind_pending_pad_picks(project, defaults=DEFAULTS)
    second = next(e for e in project.edit_decisions if e.id == SECOND)
    lane = pad_binding.usable_lanes(second)["host"].model_copy(update={"seed_sec": 3.25})

    plan = room_tone_pad(project, 20.9, 0.3, bound={"host": lane}, defaults=DEFAULTS)

    (laid,) = plan.lanes
    assert isinstance(laid, LaneSample)
    assert laid.seam.seed_sec == 3.25


def test_a_service_edit_of_a_pending_cut_binds_it_and_saves_the_binding(tmp_path: Path) -> None:
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import EditService

    project = _two_pending(tmp_path)
    path = save_project(project)
    ws = ProjectWorkspace.open(path)
    assert all(e.bound_pad is None for e in ws.project.edit_decisions)

    start, end = CUTS[SECOND]
    with write_grant(WriteGrantKind.DISPATCHER):
        EditService(ws).update_pending(SECOND, start=start, end=end, snap=False)

    saved = {e.id: e for e in load_project(path).edit_decisions}
    assert saved[SECOND].bound_pad is not None
    assert saved[FIRST].bound_pad is not None
    assert pad_binding.usable_lanes(saved[SECOND])["host"].kind == "own"


def test_the_pipeline_analysis_leaves_its_pending_cuts_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from podcast_mcp.pipeline import steps

    project = _two_pending(tmp_path)
    monkeypatch.setattr(steps, "_record_level_profiles", lambda _project: None)
    monkeypatch.setattr(
        steps,
        "propose_tighten_edits",
        lambda *_args, **_kwargs: SimpleNamespace(summary=lambda: "2 proposed"),
    )
    monkeypatch.setattr("podcast_mcp.pipeline.meta.step_noop_reason", lambda *_args: None)
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_refine_status.REFINE_GATE.assert_clear",
        lambda *_args, **_kwargs: None,
    )

    steps.analyze_fillers_pauses(project, DEFAULTS)

    assert all(pad_binding.usable_lanes(e) for e in project.edit_decisions)
