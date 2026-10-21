from __future__ import annotations

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import approve_edits
from podcast_mcp.edits.focus import propose_focus_cuts
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_cuts import add_remove_decision, coalesce_edits
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EditDecisionType,
    SourceRecording,
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

    def request(project, start, end):
        row = add_remove_decision(project, "host", start, end, defaults=load_defaults())
        if applied:
            assert approve_edits(project, [row.id], defaults=load_defaults()) == 1
        return row

    with pytest.raises(ScopeChangedAtApproval) as held:
        ws.mutate(
            "before source request",
            "after source request",
            lambda p: request(p, 1.2, 1.6),
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
        lambda p: request(p, 2, 3),
    )
    assert (row.type, row.start, row.end, row.applied) == (EditDecisionType.REMOVE, 2, 3, False)
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ([] if applied else [row.id])
    assert [record.decision_ids for record in saved.editorial.edit_log] == (
        [[row.id]] if applied else []
    )
    assert sum(c.source_end - c.source_start for c in saved.clips) == pytest.approx(
        4.98 if applied else 5.98
    )


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
    coalesce_edits(
        project, merge_ids={e.id for e in owned}, skip_counts=skips, defaults=load_defaults()
    )
    assert [
        row.model_dump() for row in project.edit_decisions if row.id.startswith("manual")
    ] == expected
    assert [(row.id, row.start, row.end) for row in project.edit_decisions] == (
        [("manual-a", 1.2, 1.4), ("manual-b", 1.42, 1.6), ("safe-a", 3, 3.4)]
        if generated
        else [("manual-a", 1.2, 1.4), ("manual-b", 1.42, 1.6)]
    )
    assert skips == ({"source_geometry": 2} if generated else {})


def test_generic_coalescer_keeps_mixed_primary_witness_state_separate(tmp_path):
    project = _project(tmp_path)
    unwitnessed = _cut("ordinary", 0, 3)
    witnessed = _cut(
        "transcript",
        1,
        2,
        source_timeline_span=RangeInterval(start=1, end=2),
    )
    project.edit_decisions = [unwitnessed, witnessed]

    assert coalesce_edits(project, defaults=load_defaults()) == 0
    assert [(row.id, row.start, row.end) for row in project.edit_decisions] == [
        ("ordinary", 0, 3),
        ("transcript", 1, 2),
    ]


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
    "kind",
    [
        "mute",
        "applied",
        "speech",
        "timeline",
        "pause",
        "exact",
        "acoustic",
        "author",
        "compatible",
    ],
)
def test_saved_text_cut_returns_actual_ordinary_survivor(tmp_path, monkeypatch, kind):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="coffee", start=1, end=2)])
    ]
    existing = None if kind == "compatible" else _cut("existing", 0, 3)
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
    elif kind == "author":
        existing.author = "reviewer"
    elif kind == "exact":
        existing.exact_range = ExactRangeTarget(
            intervals=[RangeInterval(start=0, end=3)],
            track_ids=["host"],
            clips=project.clips,
            media_seals={},
        )
    project.edit_decisions = [existing] if existing is not None else []
    expected = existing.model_dump() if existing is not None else None
    ws = ProjectWorkspace.open(save_project(project))
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    service = EditService(ws)
    if kind == "compatible":
        service.cut_time_range("host", 0, 3, use_inaudible_opt=False)
        existing = ws.project.edit_decisions[0]
        existing_id = existing.id
        assert existing.source_timeline_span is None
    else:
        existing_id = existing.id
    (returned,) = service.cut_text_match("coffee", use_inaudible_opt=False)
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
        [existing_id] if kind == "compatible" else [existing_id, returned.id]
    )
    if kind != "compatible":
        assert saved.edit_decisions[0].model_dump() == expected
    else:
        assert returned.id == existing_id
        assert returned.source_timeline_span == RangeInterval(start=0, end=3)


@pytest.mark.parametrize("producer", ["text", "words", "utterance"])
def test_current_transcript_cut_producers_reuse_the_full_ordinary_range(
    tmp_path, monkeypatch, producer
):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="coffee", start=1, end=2)])
    ]
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=1, end=2, text="coffee")
        ]
    )
    ws = ProjectWorkspace.open(save_project(project))
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    service = EditService(ws)

    service.cut_time_range("host", 0, 3, use_inaudible_opt=False)
    original_id = ws.project.edit_decisions[0].id
    if producer == "text":
        (returned,) = service.cut_text_match("coffee", use_inaudible_opt=False)
    elif producer == "words":
        service.cut_words("host", 0, 0, use_inaudible_opt=False)
        returned = ws.project.edit_decisions[0]
    else:
        service.cut_utterance(0, use_inaudible_opt=False)
        returned = ws.project.edit_decisions[0]

    assert returned.id == original_id
    assert (returned.start, returned.end) == (0, 3)
    assert returned.source_id is None
    assert returned.source_timeline_span == RangeInterval(start=0, end=3)
    assert [decision.id for decision in load_project(ws.path).edit_decisions] == [original_id]


def test_current_source_cut_does_not_merge_a_different_take(tmp_path, monkeypatch):
    project = _project(tmp_path)
    (project.workspace_path() / "raw" / "take-b.wav").write_bytes(b"take B")
    project.sources = [SourceRecording(id="B", path="raw/take-b.wav")]
    project.clips.append(
        Clip(
            id="take-b",
            track_id="host",
            source_id="B",
            source_start=0,
            source_end=6,
            timeline_start=10,
        )
    )
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="coffee", start=1, end=2)]),
        Transcript(
            track_id="host",
            source_id="B",
            words=[TranscriptWord(text="coffee", start=1, end=2)],
        ),
    ]
    ws = ProjectWorkspace.open(save_project(project))
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    service = EditService(ws)

    service.cut_time_range("host", 0, 3, use_inaudible_opt=False)
    primary_id = ws.project.edit_decisions[0].id
    service.cut_words("host", 0, 0, source_id="B", use_inaudible_opt=False)

    rows = ws.project.edit_decisions
    assert [(row.source_id, row.start, row.end) for row in rows] == [(None, 0, 3), ("B", 1, 2)]
    assert rows[0].id == primary_id
    assert rows[1].source_timeline_span == RangeInterval(start=11, end=12)


@pytest.mark.parametrize("geometry", ["moved", "deleted", "repeated"])
def test_current_source_cut_does_not_merge_stale_witness_geometry(tmp_path, monkeypatch, geometry):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="coffee", start=1, end=2),
                TranscriptWord(text="tea", start=2, end=2.5),
            ],
        )
    ]
    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range", _exact_optimizer
    )
    from podcast_mcp.edits.transcript_cuts import cut_text_match

    existing = cut_text_match(project, "coffee", use_inaudible_opt=False, defaults=load_defaults())[
        0
    ]
    if geometry == "moved":
        project.clips[0].timeline_start = 1
    elif geometry == "deleted":
        (project.workspace_path() / "raw" / "take-b.wav").write_bytes(b"take B")
        project.sources = [SourceRecording(id="B", path="raw/take-b.wav")]
        project.clips = [
            Clip(
                id="take-b",
                track_id="host",
                source_id="B",
                source_start=0,
                source_end=6,
                timeline_start=10,
            )
        ]
    else:
        project.clips.append(
            project.clips[0].model_copy(update={"id": "repeat", "timeline_start": 10})
        )

    with pytest.raises(ScopeChangedAtApproval) as held:
        cut_text_match(project, "tea", use_inaudible_opt=False, defaults=load_defaults())

    assert held.value.held[0].reason == "source_geometry"
    assert [row.id for row in project.edit_decisions] == [existing.id]


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
        add_remove_decision(
            project, "host", 1, 2, use_inaudible_opt=False, defaults=load_defaults()
        )
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
