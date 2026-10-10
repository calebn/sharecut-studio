from __future__ import annotations

import pytest

from podcast_mcp.edits.focus import propose_focus_cuts
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_cuts import add_remove_decision, coalesce_edits
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EditDecisionType,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import CutSpeech, CutSpeechTrack, ExactRangeTarget, RangeInterval
from podcast_mcp.pipeline.steps import analyze_focus_cuts
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from source_review_helpers import _cut, _exact_optimizer, _hole, _project


@pytest.mark.parametrize("applied", [False, True])
def test_original_manual_seed_cannot_contract_away_missing_source(tmp_path, monkeypatch, applied):
    project = _project(tmp_path)
    _hole(project)
    ws = ProjectWorkspace.open(save_project(project))
    before = ws.path.read_bytes()
    reads = []

    def shrink(*args, **kwargs):
        reads.append("optimized")
        return _exact_optimizer(args[0], args[1], 1.2, 1.4)

    monkeypatch.setattr("podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", shrink)
    with pytest.raises(ScopeChangedAtApproval) as held:
        ws.mutate(
            "before source request",
            "after source request",
            lambda p: add_remove_decision(p, "host", 1.2, 1.6, applied=applied),
        )
    assert held.value.held[0].reason == "source_geometry"
    assert reads == []
    assert ws.path.read_bytes() == before
    assert [(c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips] == [
        (0, 1.4, 0),
        (1.42, 6, 1.4),
    ]
    assert ws.project.edit_decisions == []
    assert ws.project.editorial.edit_log == []
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    row = ws.mutate(
        "before valid source request",
        "after valid source request",
        lambda p: add_remove_decision(p, "host", 2, 3, applied=applied),
    )
    assert (row.type, row.start, row.end, row.applied) == (EditDecisionType.REMOVE, 2, 3, applied)
    assert [e.id for e in load_project(ws.path).edit_decisions] == [row.id]


@pytest.mark.parametrize("authors", [(None, None), ("share:a", "share:b")])
@pytest.mark.parametrize("generated", [False, True])
def test_generator_preserves_every_unowned_row_before_coalescing(tmp_path, authors, generated):
    project = _project(tmp_path)
    _hole(project)
    manual = [
        _cut("manual-a", 1.2, 1.4, author=authors[0]),
        _cut("manual-b", 1.42, 1.6, author=authors[1]),
    ]
    project.edit_decisions = manual
    expected = [row.model_dump() for row in manual]
    owned = []
    if generated:
        owned = [
            _cut("safe-a", 3, 3.2),
            _cut("safe-b", 3.22, 3.4),
            _cut("hole-a", 1.2, 1.4),
            _cut("hole-b", 1.42, 1.6),
            _cut("stale-singleton", 6, 7, scope="track"),
        ]
        project.edit_decisions.extend(owned)
    skips = {}
    coalesce_edits(project, merge_ids={e.id for e in owned}, skip_counts=skips)
    assert [
        row.model_dump() for row in project.edit_decisions if row.id.startswith("manual")
    ] == expected
    assert [(row.id, row.start, row.end) for row in project.edit_decisions] == (
        [("manual-a", 1.2, 1.4), ("manual-b", 1.42, 1.6), ("safe-a", 3, 3.4)]
        if generated
        else [("manual-a", 1.2, 1.4), ("manual-b", 1.42, 1.6)]
    )
    assert skips == ({"source_geometry": 2} if generated else {})


def test_find_hits_with_zero_owned_rows_preserves_manual_source_hole(tmp_path):
    project = _project(tmp_path)
    _hole(project)
    project.transcripts = [Transcript(track_id="host", words=[])]
    project.edit_decisions = [_cut("manual-a", 1.2, 1.4), _cut("manual-b", 1.42, 1.6)]
    expected = [row.model_dump() for row in project.edit_decisions]
    proposal = propose_tighten_edits(
        project,
        {"tighten": {"acoustic_gap_filler": {"enabled": False}}, "performance": {"max_workers": 1}},
    )
    assert proposal.to_payload()["edits"] == []
    assert [row.model_dump() for row in project.edit_decisions] == expected
    assert proposal.skip_counts == {}


@pytest.mark.parametrize(
    "kind", ["mute", "applied", "speech", "timeline", "pause", "exact", "acoustic", "compatible"]
)
def test_saved_text_cut_returns_actual_ordinary_survivor(tmp_path, monkeypatch, kind):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="coffee", start=1, end=2)])
    ]
    existing = _cut("existing", 0, 3)
    if kind == "mute":
        existing.type = EditDecisionType.MUTE
    elif kind == "applied":
        existing.applied = True
    elif kind == "speech":
        existing.cut_speech = CutSpeech(
            spans=[RangeInterval(start=0, end=3)],
            tracks=[CutSpeechTrack(track_id="guest", speaker="Guest")],
        )
    elif kind == "timeline":
        existing.timebase = "timeline"
    elif kind == "pause":
        existing.reason = "pause:3.00s"
        existing.replace_gap_sec = 0.2
        existing.review_required = True
    elif kind == "acoustic":
        existing.reason = "filler:acoustic"
        existing.review_required = True
    elif kind == "exact":
        existing.exact_range = ExactRangeTarget(
            intervals=[RangeInterval(start=0, end=3)],
            track_ids=["host"],
            clips=project.clips,
            media_seals={},
        )
    project.edit_decisions = [existing]
    expected = existing.model_dump()
    ws = ProjectWorkspace.open(save_project(project))
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    (returned,) = EditService(ws).cut_text_match("coffee", use_inaudible_opt=False)
    saved = load_project(ws.path)
    actual = next(e for e in ws.project.edit_decisions if e.id == returned.id)
    assert actual is returned
    assert (
        returned.type,
        returned.timebase,
        returned.applied,
        returned.exact_range,
        returned.cut_speech,
    ) == (EditDecisionType.REMOVE, "source", False, None, None)
    assert (returned.start, returned.end) == ((0, 3) if kind == "compatible" else (1, 2))
    assert [e.id for e in saved.edit_decisions] == (
        ["existing"] if kind == "compatible" else ["existing", returned.id]
    )
    if kind != "compatible":
        assert saved.edit_decisions[0].model_dump() == expected


@pytest.mark.parametrize("field", ["type", "timebase", "applied", "cut_speech", "bounds", "exact"])
def test_manual_survivor_same_id_must_still_be_an_ordinary_remove(tmp_path, monkeypatch, field):
    project = _project(tmp_path)
    project.edit_decisions = [_cut("retained", 4, 5)]
    before = [e.model_dump() for e in project.edit_decisions]

    def malformed_result(staged, **_kwargs):
        row = staged.edit_decisions[-1].model_copy(deep=True)
        staged.edit_decisions[-1] = row
        if field == "type":
            row.type = EditDecisionType.MUTE
        elif field == "timebase":
            row.timebase = "timeline"
        elif field == "applied":
            row.applied = True
        elif field == "cut_speech":
            row.cut_speech = CutSpeech(
                spans=[RangeInterval(start=1, end=2)],
                tracks=[CutSpeechTrack(track_id="guest", speaker="Guest")],
            )
        elif field == "bounds":
            row.start, row.end = 1.2, 1.8
        else:
            row.exact_range = ExactRangeTarget(
                intervals=[RangeInterval(start=1, end=2)],
                track_ids=["host"],
                clips=staged.clips,
                media_seals={},
            )
        return 0

    monkeypatch.setattr("podcast_mcp.edits.transcript_cuts.coalesce_edits", malformed_result)
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    with pytest.raises(RuntimeError, match="survivor"):
        add_remove_decision(project, "host", 1, 2, use_inaudible_opt=False)
    assert [e.model_dump() for e in project.edit_decisions] == before


def _focus_project(tmp_path):
    project = _project(tmp_path)
    _hole(project)
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=start, end=end, text=text)
            for start, end, text in [
                (1.2, 1.4, "alpha"),
                (1.42, 1.6, "beta"),
                (2.2, 2.4, "alpha"),
                (2.8, 3, "beta"),
                (4, 4.2, "gamma"),
                (5, 5.2, "gamma"),
            ]
        ]
    )
    project.edit_decisions = [_cut("manual-a", 1.2, 1.4), _cut("manual-b", 1.42, 1.6)]
    return project


FOCUS_DEFAULTS = {
    "focus": {
        "enabled": True,
        "review_required": False,
        "segment_merge_gap_sec": 0,
        "min_segment_sec": 0.1,
        "max_remove_pct": 1,
        "repeat_word_overlap": 0.9,
    }
}


@pytest.mark.parametrize("supplied_sink", [False, True])
def test_focus_counts_merged_hold_and_publishes_clean_survivor(tmp_path, supplied_sink):
    project = _focus_project(tmp_path)
    expected = [e.model_dump() for e in project.edit_decisions]
    skips = {}
    rows = propose_focus_cuts(project, FOCUS_DEFAULTS, skip_counts=skips if supplied_sink else None)
    assert [(e.start, e.end, e.applied) for e in rows] == [(4, 4.2, False)]
    assert [e.model_dump() for e in project.edit_decisions[:2]] == expected
    assert [e.id for e in project.edit_decisions] == ["manual-a", "manual-b", rows[0].id]
    if supplied_sink:
        assert skips == {"source_geometry": 1}


def test_focus_pipeline_reports_merged_hold_without_aborting(tmp_path):
    project = _focus_project(tmp_path)
    expected = [e.model_dump() for e in project.edit_decisions]
    summary = analyze_focus_cuts(project, FOCUS_DEFAULTS)
    assert summary == "1 focus cuts proposed; held 1 source_geometry"
    assert [(e.start, e.end) for e in project.edit_decisions[2:]] == [(4, 4.2)]
    assert [e.model_dump() for e in project.edit_decisions[:2]] == expected
