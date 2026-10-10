from __future__ import annotations

import pytest

from podcast_mcp.edits.ripple import EditMode
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    CutSpeech,
    CutSpeechTrack,
    EditDecisionType,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval
from podcast_mcp.project_store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate


def _open(project):
    mark_refine_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    return ProjectWorkspace.open(save_project(project))


def test_genuinely_joining_stale_pending_row_blocks_addition_atomically(tmp_path):
    project = _project(tmp_path)
    project.edit_decisions = [_cut("joining-stale", 1, 2, review_required=True, crossfade_ms=17)]
    ws = _open(project)
    EditService(ws).cut_range(1.4, 1.42, mode=EditMode.GAP, track_ids=["host"])
    before_disk = ws.path.read_bytes()
    before_memory = ws.project.model_dump(mode="json")
    index = history_index_path(ws.project)
    before_index = index.read_bytes()
    before_snapshots = history_snapshot_ids(index)

    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).cut_time_range(
            "host", 2.02, 2.4, reason="nl:range", use_inaudible_opt=False
        )

    assert held.value.code == "cut_scope_changed"
    assert held.value.ids == ("joining-stale",)
    assert held.value.held[0].reason == "source_geometry"
    assert ws.path.read_bytes() == before_disk
    assert ws.project.model_dump(mode="json") == before_memory
    assert index.read_bytes() == before_index
    assert history_snapshot_ids(index) == before_snapshots
    assert [(e.id, e.start, e.end) for e in load_project(ws.path).edit_decisions] == [
        ("joining-stale", 1, 2)
    ]


def test_manual_addition_owns_transitive_joiners_and_preserves_excluded_row_order(tmp_path):
    project = _project(tmp_path)
    project.edit_decisions = [
        _cut("excluded-right", 5, 5.4, author="share:right", crossfade_ms=19, cut_confidence=0.63),
        _cut("join-a", 1, 1.4, crossfade_ms=17, review_required=True),
        _cut(
            "excluded-left", 0.1, 0.3, author="share:left", next_burst_sec=0.5, review_required=True
        ),
        _cut("join-b", 1.44, 1.8, crossfade_ms=17, review_required=True),
    ]
    ws = _open(project)
    excluded_ids = {"excluded-right", "excluded-left"}
    excluded = [e.model_dump_json() for e in ws.project.edit_decisions if e.id in excluded_ids]
    clips = [c.model_dump(mode="json") for c in ws.project.clips]

    EditService(ws).cut_time_range("host", 1.84, 2.2, reason="nl:range", use_inaudible_opt=False)

    saved = load_project(ws.path)
    assert [e.model_dump_json() for e in saved.edit_decisions if e.id in excluded_ids] == excluded
    assert [(e.id, e.start, e.end) for e in saved.edit_decisions if e.id not in excluded_ids] == [
        ("join-a", 1, 2.2)
    ]
    assert [e.id for e in saved.edit_decisions if e.id in excluded_ids] == [
        "excluded-right",
        "excluded-left",
    ]
    assert [c.model_dump(mode="json") for c in saved.clips] == clips
    assert saved.editorial.edit_log == []


@pytest.mark.parametrize(
    "barrier",
    [
        "pause",
        "acoustic",
        "restart",
        "author",
        "applied",
        "scope",
        "boundary",
        "speech",
        "timebase",
        "exact",
        "mute",
    ],
)
def test_manual_addition_preserves_independent_review_and_identity_barriers(tmp_path, barrier):
    project = _project(tmp_path)
    row = _cut("barrier", 1, 2, review_required=True, crossfade_ms=27, cut_confidence=0.81)
    if barrier == "pause":
        row.reason = "pause:1.00s"
        row.replace_gap_sec = 0.2
    elif barrier == "acoustic":
        row.reason = "filler:acoustic"
    elif barrier == "restart":
        row.reason = "restart:repeat"
        row.id = "restart_barrier"
    elif barrier == "author":
        row.author = "share:other"
    elif barrier == "applied":
        row.applied = True
    elif barrier == "scope":
        row.scope = "track"
    elif barrier == "boundary":
        row.boundary_mode = "waveform_only"
    elif barrier == "speech":
        row.cut_speech = CutSpeech(
            spans=[RangeInterval(start=1, end=2)],
            tracks=[CutSpeechTrack(track_id="guest", speaker="Guest")],
        )
    elif barrier == "timebase":
        row.timebase = "timeline"
    elif barrier == "exact":
        row.exact_range = ExactRangeTarget(
            intervals=[RangeInterval(start=1, end=2)],
            track_ids=["host"],
            clips=project.clips,
            media_seals={},
        )
    else:
        row.type = EditDecisionType.MUTE
    project.edit_decisions = [row]
    ws = _open(project)
    original = ws.project.edit_decisions[0].model_dump_json()

    EditService(ws).cut_time_range("host", 2.02, 2.4, reason="nl:range", use_inaudible_opt=False)

    saved = load_project(ws.path)
    assert len(saved.edit_decisions) == 2
    assert next(e for e in saved.edit_decisions if e.id == row.id).model_dump_json() == original
    fresh = next(e for e in saved.edit_decisions if e.id != row.id)
    assert (
        fresh.start,
        fresh.end,
        fresh.reason,
        fresh.type.value,
        fresh.timebase,
        fresh.scope,
        fresh.applied,
        fresh.review_required,
    ) == (2.02, 2.4, "nl:range", "remove", "source", "session", False, True)
    assert saved.timeline.duration_sec == 6
    assert saved.editorial.edit_log == []


def test_disjoint_stale_rows_keep_serialized_metadata_and_relative_order(tmp_path):
    project = _project(tmp_path)
    project.edit_decisions = [
        _cut("right", 5, 5.4, author="share:right", crossfade_ms=19),
        _cut(
            "stale",
            1,
            2,
            crossfade_ms=17,
            cut_confidence=0.73,
            next_burst_sec=2.1,
            review_required=True,
        ),
        _cut("left", 0.1, 0.3, author="share:left", review_required=True),
    ]
    ws = _open(project)
    EditService(ws).cut_range(1.4, 1.42, mode=EditMode.GAP, track_ids=["host"])
    excluded = [e.model_dump_json() for e in ws.project.edit_decisions]
    clips = [c.model_dump(mode="json") for c in ws.project.clips]
    archives = [r.model_dump(mode="json") for r in ws.project.editorial.edit_log]

    EditService(ws).cut_time_range("host", 3, 4, reason="nl:range", use_inaudible_opt=False)

    saved = load_project(ws.path)
    assert [
        e.model_dump_json() for e in saved.edit_decisions if e.id in {"right", "stale", "left"}
    ] == excluded
    assert [e.id for e in saved.edit_decisions if e.id in {"right", "stale", "left"}] == [
        "right",
        "stale",
        "left",
    ]
    assert [
        (e.start, e.end) for e in saved.edit_decisions if e.id not in {"right", "stale", "left"}
    ] == [(3, 4)]
    assert [c.model_dump(mode="json") for c in saved.clips] == clips
    assert [r.model_dump(mode="json") for r in saved.editorial.edit_log] == archives
