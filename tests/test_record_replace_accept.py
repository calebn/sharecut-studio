"""Accepting a replace-target session removes its range and puts one take in its place."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.audio_check_override import OVERRIDE_PARAM, audio_check_override
from podcast_mcp.edits.comment_remap import remap_interval_for_replace
from podcast_mcp.edits.comments import add_comment
from podcast_mcp.edits.insert_anchor import capture_range_anchors
from podcast_mcp.edits.record_placement import upsert_source
from podcast_mcp.edits.ripple import (
    RippleRemoval,
    TrackExtent,
    ripple_insert_clips,
    ripple_remove_clips,
)
from podcast_mcp.edits.session_suggestions import ensure_session_suggestion
from podcast_mcp.edits.timeline_ops import _write_ripple_delete, ripple_delete_range
from podcast_mcp.mcp.tools.review import accept_session_suggestion_tool
from podcast_mcp.models import (
    ChapterMarker,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    SessionSuggestion,
    StagedComment,
    StagedTake,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import HistoryService, SessionSuggestionService
from podcast_mcp.services.record.landing import RecordLandingService
from podcast_mcp.util.coded_error import CodedValueError
from test_record_staging import (
    _cmd,
    _everything,
    _join,
    _record,
    _seed,
    _stage,
    _suggestion,
)

SID = "a" * 12
SUGGESTION = f"ss-{SID}"

Segment = tuple[str, float, float]


def _seed_two_speakers(ws) -> None:
    def build(project: EpisodeProject) -> None:
        project.tracks.extend(
            [
                Track(id="host", label="Host", role=TrackRole.DIALOGUE),
                Track(id="guest", label="Guest", role=TrackRole.DIALOGUE),
                Track(id="music", label="Music", role=TrackRole.MUSIC),
            ]
        )
        project.clips.extend(
            [
                Clip(
                    id="h1",
                    track_id="host",
                    source_id="src-host",
                    source_start=0.0,
                    source_end=10.0,
                    timeline_start=0.0,
                ),
                Clip(
                    id="g1",
                    track_id="guest",
                    source_id="src-guest",
                    source_start=0.0,
                    source_end=10.0,
                    timeline_start=0.0,
                ),
                Clip(
                    id="m1",
                    track_id="music",
                    source_id="src-music",
                    source_start=0.0,
                    source_end=2.0,
                    timeline_start=8.0,
                ),
            ]
        )

    ws.mutate("seed", "seeded", build)


def _stage_replace(
    ws,
    from_sec: float,
    to_sec: float,
    takes: dict[int, list[Segment]],
    *,
    track_ids: list[str] | None = None,
    comments: dict[int, list[tuple[str, int]]] | None = None,
    capture: bool = True,
    session_id: str = SID,
    number: int = 1,
) -> str:
    named = ["host"] if track_ids is None else track_ids

    def build(project: EpisodeProject) -> None:
        anchor, end_anchor = (
            capture_range_anchors(project, from_sec, to_sec, named) if capture else (None, None)
        )
        staged: list[StagedTake] = []
        for take_index, segments in sorted(takes.items()):
            for segment_index, (track_id, offset_s, duration_s) in enumerate(segments):
                source_id = f"rec-{session_id}-{take_index}-{track_id}-{segment_index}"
                rel = f"raw/{source_id}.wav"
                upsert_source(
                    project,
                    source_id=source_id,
                    rel=rel,
                    speaker=track_id,
                    duration_s=duration_s,
                    sample_rate=48_000,
                    channels=1,
                )
                held = [
                    StagedComment(
                        id=f"live-{take_index}-{i}",
                        author=track_id,
                        body=f"note {take_index}",
                        recording_ms=recording_ms,
                        timeline_offset_s=0.0,
                    )
                    for i, (_label, recording_ms) in enumerate(
                        (comments or {}).get(take_index, []) if segment_index == 0 else []
                    )
                ]
                staged.append(
                    StagedTake(
                        take_index=take_index,
                        track_id=track_id,
                        track_label=track_id.title(),
                        segment_index=segment_index,
                        source_id=source_id,
                        offset_s=offset_s,
                        duration_s=duration_s,
                        comments=held,
                    )
                )
        ensure_session_suggestion(
            project,
            SessionSuggestion(
                id=f"ss-{session_id}",
                kind="replace",
                session_id=session_id,
                session_number=number,
                from_sec=from_sec,
                to_sec=to_sec,
                track_ids=named,
                anchor=anchor,
                end_anchor=end_anchor,
                takes=staged,
            ),
        )

    ws.mutate("stage", "staged", build)
    return f"ss-{session_id}"


def _clips(ws, track_id: str) -> list[Clip]:
    ws.reload()
    return sorted(
        (c for c in ws.project.clips if c.track_id == track_id), key=lambda c: c.timeline_start
    )


def _shape(ws, track_id: str) -> list[tuple[str | None, float, float, float]]:
    return [
        (c.source_id, c.source_start, c.source_end, round(c.timeline_start, 6))
        for c in _clips(ws, track_id)
    ]


def _end(ws) -> float:
    ws.reload()
    return max(c.timeline_end for c in ws.project.clips if c.track_id in ("host", "guest"))


@pytest.fixture
def ws(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_speech.speech_energy_guard_enabled", lambda _defaults: False
    )
    workspace = _seed(minimal_project, sample_wav)
    _seed_two_speakers(workspace)
    return workspace


def test_a_longer_take_ripples_every_dialogue_track_by_the_difference(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    before_host = _shape(ws, "host")[0]
    result = SessionSuggestionService(ws).accept(sid)
    assert (result["from_sec"], result["to_sec"], result["at_sec"]) == (2.0, 4.0, 2.0)
    assert (result["removed_s"], result["span_s"], result["delta_s"]) == (2.0, 3.0, 1.0)
    assert _end(ws) == pytest.approx(11.0)
    host = _shape(ws, "host")
    assert before_host[0] == "src-host"
    assert host[0] == ("src-host", 0.0, 2.0, 0.0)
    assert host[1][0].startswith(f"rec-{SID}-0-host")
    assert host[1][3] == 2.0
    assert host[2] == ("src-host", 4.0, 10.0, 5.0)
    assert _shape(ws, "guest") == [("src-guest", 0.0, 2.0, 0.0), ("src-guest", 4.0, 10.0, 5.0)]
    assert result["unmoved_track_ids"] == ["music"]
    assert _clips(ws, "music")[0].timeline_start == 8.0
    assert ws.project.timeline.duration_sec == pytest.approx(11.0)


def test_a_shorter_take_closes_the_difference_and_a_same_length_one_moves_nothing(ws) -> None:
    short = _stage_replace(ws, 2.0, 5.0, {0: [("host", 0.0, 1.0)]})
    result = SessionSuggestionService(ws).accept(short)
    assert result["delta_s"] == pytest.approx(-2.0)
    assert _end(ws) == pytest.approx(8.0)
    assert _shape(ws, "guest")[-1] == ("src-guest", 5.0, 10.0, 3.0)
    assert result["unmoved_track_ids"] == ["music"]
    HistoryService(ws).undo()
    same = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 2.0)]}, session_id="b" * 12, number=2)
    result = SessionSuggestionService(ws).accept(same)
    assert result["delta_s"] == pytest.approx(0.0)
    assert result["unmoved_track_ids"] == []
    assert _end(ws) == pytest.approx(10.0)


def test_a_pickup_recorded_on_two_tracks_is_as_long_as_its_longest_segment(ws) -> None:
    sid = _stage_replace(
        ws,
        2.0,
        4.0,
        {0: [("host", 0.5, 2.5), ("guest", 0.0, 2.0)]},
        track_ids=["host", "guest"],
    )
    result = SessionSuggestionService(ws).accept(sid)
    assert result["span_s"] == pytest.approx(3.0)
    assert _end(ws) == pytest.approx(11.0)
    host = _clips(ws, "host")
    guest = _clips(ws, "guest")
    assert [round(c.timeline_start, 6) for c in host] == [0.0, 2.5, 5.0]
    assert [round(c.timeline_start, 6) for c in guest] == [0.0, 2.0, 5.0]
    assert guest[1].timeline_end == pytest.approx(4.0)


def test_the_range_is_removed_to_the_exact_span_with_no_snapping(ws) -> None:
    sid = _stage_replace(ws, 2.37, 5.91, {0: [("host", 0.0, 1.0)]})
    SessionSuggestionService(ws).accept(sid)
    for track in ("host", "guest"):
        left, _take, right = (
            _clips(ws, track)
            if track == "host"
            else (*_clips(ws, track)[:1], None, *_clips(ws, track)[-1:])
        )
        assert left.source_end == pytest.approx(2.37)
        assert right.source_start == pytest.approx(5.91)
    [record] = ws.project.editorial.edit_log
    assert record.operation == "ripple_delete"
    assert (record.timeline_start, record.timeline_end) == (
        pytest.approx(2.37),
        pytest.approx(5.91),
    )
    assert record.params["use_inaudible_opt"] is False


def test_accept_writes_one_applied_record_naming_the_replace_and_one_history_step(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]}, number=3)
    before = len(ws.project.history.entries)
    SessionSuggestionService(ws).accept(sid)
    ws.reload()
    [record] = ws.project.editorial.edit_log
    assert record.params["replace"] == {
        "session_id": SID,
        "suggestion_id": sid,
        "session_number": 3,
        "take_index": 0,
        "inserted_s": 3.0,
    }
    assert "cut_speech" not in record.params
    assert HistoryService(ws).list_entries().groups[-1].title == "Added Session 3"
    entry = ws.project.history.entries[-1]
    assert entry.operation == "accept_session_suggestion"
    assert len(ws.project.history.entries) == before + 1


def test_take_choice_defaults_to_the_last_take_and_places_only_that_one(ws) -> None:
    sid = _stage_replace(
        ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)], 2: [("host", 0.0, 3.0)]}
    )
    result = SessionSuggestionService(ws).accept(sid)
    assert result["take_index"] == 2
    assert result["suggestion"]["selected_take"] == 2
    placed = [c.source_id for c in _clips(ws, "host")]
    assert placed[1] == f"rec-{SID}-2-host-0"
    assert not any("-0-host" in (s or "") or "-1-host" in (s or "") for s in placed)
    HistoryService(ws).undo()
    assert _suggestion_row(ws).selected_take is None


def _suggestion_row(ws) -> SessionSuggestion:
    ws.reload()
    return ws.project.editorial.session_suggestions[0]


def test_an_explicit_take_beats_the_selected_take_and_the_selected_take_beats_the_last(ws) -> None:
    sid = _stage_replace(
        ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 2.0)], 2: [("host", 0.0, 3.0)]}
    )

    def select(project: EpisodeProject) -> None:
        project.editorial.session_suggestions[0].selected_take = 1

    ws.mutate("select", "selected", select)
    service = SessionSuggestionService(ws)
    assert service.accept(sid, take_index=0)["take_index"] == 0
    HistoryService(ws).undo()
    assert service.accept(sid)["take_index"] == 1


def test_an_unknown_take_is_refused_naming_the_takes_there_are(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 2: [("host", 0.0, 3.0)]})
    before = _everything(ws)
    with pytest.raises(CodedValueError, match=r"no take 1\. Pick one of: 0, 2") as refused:
        SessionSuggestionService(ws).accept(sid, take_index=1)
    assert refused.value.code == "take_not_found"
    assert _everything(ws) == before


def test_a_take_cannot_be_chosen_for_an_insert(ws) -> None:
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 1.0})
    sid = f"ss-{room['session_id']}"
    before = _everything(ws)
    with pytest.raises(CodedValueError) as refused:
        SessionSuggestionService(ws).accept(sid, take_index=0)
    assert refused.value.code == "take_not_applicable"
    assert _everything(ws) == before
    assert SessionSuggestionService(ws).accept(sid)["suggestion"]["status"] == "accepted"


def _words(ws, track_id: str, *rows: tuple[str, float, float]) -> None:
    def add(project: EpisodeProject) -> None:
        project.transcripts.append(
            Transcript(
                track_id=track_id,
                source_id=f"src-{track_id}",
                words=[TranscriptWord(text=t, start=a, end=b) for t, a, b in rows],
            )
        )

    ws.mutate("words", "worded", add)


def test_another_speakers_words_in_the_range_hold_the_accept_until_it_is_confirmed(ws) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8), ("plan", 3.0, 3.4))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    before = _everything(ws)
    steps = len(ws.project.history.entries)
    held = SessionSuggestionService(ws).accept(sid)
    assert held["unchanged"] is True
    confirmation = held["needs_confirmation"]
    assert confirmation["reason"] == "cuts_other_speech"
    assert confirmation["message"] == (
        'Replacing this range also removes 2 words from Guest: "so plan". '
        "Replace anyway to apply it; undo brings it back."
    )
    assert "override_audio_checks=true" in held["apply_anyway"]
    assert _everything(ws) == before
    ws.reload()
    assert len(ws.project.history.entries) == steps
    applied = SessionSuggestionService(ws).accept(sid, override_audio_checks=True)
    assert applied["suggestion"]["status"] == "accepted"
    [record] = ws.project.editorial.edit_log
    assert [t["track_id"] for t in record.params["cut_speech"]["tracks"]] == ["guest"]


def test_an_override_context_stamps_who_overrode_in_the_record(ws) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    with audio_check_override("tester", "test"):
        SessionSuggestionService(ws).accept(sid)
    ws.reload()
    [record] = ws.project.editorial.edit_log
    assert record.params[OVERRIDE_PARAM]["actor"] == "tester"
    assert ws.project.history.entries[-1].params[OVERRIDE_PARAM]["surface"] == "test"


def test_the_recorded_tracks_own_speech_and_a_silent_other_track_never_ask(ws) -> None:
    _words(ws, "host", ("hello", 2.5, 2.9))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    result = SessionSuggestionService(ws).accept(sid)
    assert "needs_confirmation" not in result
    ws.reload()
    [transcript] = [t for t in ws.project.transcripts if t.track_id == "host"]
    assert [w.text for w in transcript.words] == []
    assert [a.word.text for a in transcript.archived_words] == ["hello"]
    HistoryService(ws).undo()
    ws.reload()
    [transcript] = [t for t in ws.project.transcripts if t.track_id == "host"]
    assert [w.text for w in transcript.words] == ["hello"]
    assert transcript.archived_words == []


def test_a_track_the_pickup_names_but_the_take_did_not_record_is_refused(ws) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]}, track_ids=["host", "guest"])
    before = _everything(ws)
    with pytest.raises(CodedValueError, match="did not record guest") as refused:
        SessionSuggestionService(ws).accept(sid, override_audio_checks=True)
    assert refused.value.code == "track_not_recorded"
    assert _everything(ws) == before


def test_a_take_on_a_non_dialogue_track_is_refused(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("music", 0.0, 1.0)]}, track_ids=["music"])
    before = _everything(ws)
    with pytest.raises(CodedValueError) as refused:
        SessionSuggestionService(ws).accept(sid)
    assert refused.value.code == "track_not_dialogue"
    assert _everything(ws) == before


def test_a_missing_staged_source_and_the_refine_gate_refuse_before_anything_changes(ws) -> None:
    from podcast_mcp.edits.transcript_refine_status import REFINE_GATE

    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    before = _everything(ws)
    with (
        patch.object(
            REFINE_GATE,
            "assert_clear",
            side_effect=CodedValueError("refine first", code="refine_pending"),
        ),
        pytest.raises(CodedValueError) as gated,
    ):
        SessionSuggestionService(ws).accept(sid)
    assert gated.value.code == "refine_pending"
    ws.mutate(
        "drop sources",
        "dropped sources",
        lambda p: setattr(p, "sources", [s for s in p.sources if not s.id.startswith("rec-")]),
    )
    gone = _everything(ws)
    with pytest.raises(CodedValueError) as missing:
        SessionSuggestionService(ws).accept(sid)
    assert missing.value.code == "staged_source_missing"
    assert _everything(ws) == gone
    assert before != gone


def _stale(ws, sid: str) -> CodedValueError:
    before = _everything(ws)
    with pytest.raises(CodedValueError) as refused:
        SessionSuggestionService(ws).accept(sid)
    assert refused.value.code == "stale_anchor"
    assert _everything(ws) == before
    return refused.value


def test_a_row_staged_without_end_points_and_a_range_off_the_audio_are_refused(ws) -> None:
    old = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]}, capture=False)
    assert "starts and ends on speech" in str(_stale(ws, old))
    HistoryService(ws).undo()
    ws.mutate(
        "drop",
        "dropped",
        lambda p: setattr(p.editorial, "session_suggestions", []),
    )
    off = _stage_replace(ws, 9.0, 11.0, {0: [("host", 0.0, 1.0)]}, session_id="b" * 12)
    assert _suggestion_row(ws).end_anchor is None
    assert "starts and ends on speech" in str(_stale(ws, off))


def test_staging_over_speech_captures_clip_anchors_on_the_named_track_and_never_an_end(ws) -> None:
    anchor, end_anchor = capture_range_anchors(ws.project, 2.0, 10.0, ["guest"])
    assert anchor is not None and end_anchor is not None
    assert (anchor.kind, anchor.track_id, anchor.side, anchor.source_sec) == (
        "clip",
        "guest",
        "before",
        2.0,
    )
    assert (end_anchor.kind, end_anchor.track_id, end_anchor.side, end_anchor.source_sec) == (
        "clip",
        "guest",
        "after",
        10.0,
    )
    mid = capture_range_anchors(ws.project, 2.0, 4.0, ["host"])[1]
    assert mid is not None
    assert (mid.side, mid.source_sec, mid.offset_s) == ("before", 4.0, 0.0)
    assert capture_range_anchors(ws.project, 2.0, 12.0, ["host"]) == (None, None)


def test_the_range_follows_the_audio_through_earlier_cuts_and_inserts(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]})
    ids = ["host", "guest"]
    ws.mutate(
        "cut",
        "cut",
        lambda p: ripple_remove_clips(p, [(0.0, 1.0)], ids, defaults=ws.effective_config()),
    )
    ws.mutate(
        "gap",
        "gapped",
        lambda p: ripple_insert_clips(p, 0.5, 2.5, ids, defaults=ws.effective_config()),
    )
    result = SessionSuggestionService(ws).accept(sid)
    assert (result["from_sec"], result["to_sec"]) == (pytest.approx(3.5), pytest.approx(5.5))


def test_a_trimmed_boundary_a_cut_across_and_audio_added_inside_are_stale(ws) -> None:
    def trim(project: EpisodeProject, **changes: float) -> None:
        clip = next(c for c in project.clips if c.id == "h1")
        for name, value in changes.items():
            setattr(clip, name, value)

    for index, edit in enumerate(
        (
            lambda p: trim(p, source_start=2.5, timeline_start=2.5),
            lambda p: trim(p, source_end=3.5),
            lambda p: ripple_remove_clips(
                p, [(3.0, 3.5)], ["host", "guest"], defaults=ws.effective_config()
            ),
            lambda p: ripple_insert_clips(
                p, 3.0, 1.0, ["host", "guest"], defaults=ws.effective_config()
            ),
        )
    ):
        sid = _stage_replace(
            ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]}, session_id=f"{index:012d}", number=index + 1
        )
        ws.mutate("edit", "edited", edit)
        _stale(ws, sid)
        HistoryService(ws).undo()
        HistoryService(ws).undo()
        ws.mutate(
            "drop",
            "dropped",
            lambda p: setattr(p.editorial, "session_suggestions", []),
        )


def test_a_range_that_was_cut_away_whole_and_a_second_copy_of_the_audio_are_stale(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]})
    ws.mutate(
        "cut",
        "cut",
        lambda p: ripple_remove_clips(
            p, [(2.0, 4.0)], ["host", "guest"], defaults=ws.effective_config()
        ),
    )
    _stale(ws, sid)
    HistoryService(ws).undo()

    def copy_and_shift(project: EpisodeProject) -> None:
        project.clips.append(
            Clip(
                id="dup",
                track_id="host",
                source_id="src-host",
                source_start=0.0,
                source_end=10.0,
                timeline_start=20.0,
            )
        )
        ripple_insert_clips(project, 0.5, 1.0, ["host", "guest"], defaults=ws.effective_config())

    ws.mutate("copy", "copied", copy_and_shift)
    _stale(ws, sid)


def test_an_episode_appended_after_the_range_end_does_not_grow_the_range(ws) -> None:
    sid = _stage_replace(ws, 6.0, 10.0, {0: [("host", 0.0, 1.0)]})
    ws.mutate(
        "append",
        "appended",
        lambda p: p.clips.append(
            Clip(
                id="tail",
                track_id="host",
                source_id="src-tail",
                source_start=0.0,
                source_end=5.0,
                timeline_start=10.0,
            )
        ),
    )
    result = SessionSuggestionService(ws).accept(sid)
    assert (result["from_sec"], result["to_sec"]) == (6.0, 10.0)
    assert _clips(ws, "host")[-1].timeline_start == pytest.approx(7.0)


def _comments(ws) -> None:
    def add(project: EpisodeProject) -> None:
        for name, start, end in (
            ("atfrom", 2.0, None),
            ("atto", 4.0, None),
            ("inside", 3.0, None),
            ("straddle", 1.0, 5.0),
            ("after", 6.0, None),
            ("equal", 2.0, 4.0),
            ("insideiv", 2.5, 3.5),
            ("tail", 3.0, 6.0),
            ("head", 1.0, 3.0),
            ("endto", 3.0, 4.0),
            ("spans", 1.0, None),
        ):
            add_comment(
                project,
                body=name,
                author="rev",
                timeline_start=start,
                timeline_end=end,
                comment_id=name,
            )
        spans = [
            RangeInterval(start=1.0, end=2.5),
            RangeInterval(start=2.5, end=3.5),
            RangeInterval(start=5.0, end=6.0),
        ]
        project.review.comments = [
            c.model_copy(update={"timeline_spans": spans}) if c.id == "spans" else c
            for c in project.review.comments
        ]
        project.editorial.chapters = [
            ChapterMarker(time=t, title=f"c{t}") for t in (1.0, 2.0, 3.0, 4.0, 6.0)
        ]

    ws.mutate("comments", "commented", add)


def test_comments_and_chapters_are_kept_and_mapped_by_the_replace_rules(ws) -> None:
    _comments(ws)
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    result = SessionSuggestionService(ws).accept(sid)
    ws.reload()
    by_id = {c.id: (c.timeline_start, c.timeline_end) for c in ws.project.comments}
    assert by_id == {
        "atfrom": (2.0, None),
        "atto": (5.0, None),
        "inside": (2.0, None),
        "straddle": (1.0, 6.0),
        "after": (7.0, None),
        "equal": (2.0, 5.0),
        "insideiv": (2.0, None),
        "tail": (5.0, 7.0),
        "head": (1.0, 2.0),
        "endto": (2.0, 5.0),
        "spans": (1.0, None),
    }
    spans = next(c for c in ws.project.comments if c.id == "spans").timeline_spans
    assert [(s.start, s.end) for s in spans] == [(1.0, 2.0), (6.0, 7.0)]
    assert sorted(result["clamped_comment_ids"]) == ["endto", "inside", "insideiv", "tail"]
    assert [c.time for c in ws.project.editorial.chapters] == [1.0, 2.0, 2.0, 5.0, 7.0]


def test_a_shorter_replace_pulls_later_comments_back_and_keeps_inside_ones(ws) -> None:
    assert remap_interval_for_replace(6.0, None, 2.0, 5.0, 1.0).start == pytest.approx(4.0)
    assert remap_interval_for_replace(3.0, None, 2.0, 5.0, 1.0).start == 2.0
    moved = remap_interval_for_replace(1.0, 7.0, 2.0, 5.0, 1.0)
    assert (moved.start, moved.end) == (1.0, pytest.approx(5.0))
    same = remap_interval_for_replace(6.0, 7.0, 2.0, 5.0, 3.0)
    assert (same.start, same.end) == (6.0, 7.0)


def _decisions(ws) -> None:
    def add(project: EpisodeProject) -> None:
        for edit_id, track_id, start, end, timebase in (
            ("before", "host", 0.5, 1.0, "timeline"),
            ("after", "host", 6.0, 6.5, "timeline"),
            ("music", "music", 6.0, 6.5, "timeline"),
            ("src-in", "host", 3.2, 3.5, "source"),
            ("src-out", "host", 6.0, 6.5, "source"),
        ):
            project.editorial.edit_decisions.append(
                EditDecision(
                    id=edit_id,
                    track_id=track_id,
                    type=EditDecisionType.MUTE,
                    start=start,
                    end=end,
                    timebase=timebase,
                    applied=False,
                )
            )

    ws.mutate("decisions", "decided", add)


def test_pending_edits_after_the_range_move_and_source_ones_inside_are_retired(ws) -> None:
    _decisions(ws)
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    result = SessionSuggestionService(ws).accept(sid)
    ws.reload()
    spans = {e.id: (e.start, e.end) for e in ws.project.editorial.edit_decisions}
    assert spans["before"] == (0.5, 1.0)
    assert spans["after"] == (7.0, 7.5)
    assert spans["music"] == (6.0, 6.5)
    assert "src-in" not in spans
    assert "src-out" in spans
    assert result["retired_decision_ids"] == ["src-in"]


@pytest.mark.parametrize("window", [(2.5, 3.0), (1.0, 2.5), (3.5, 5.0), (2.0, 4.0)])
def test_pending_timeline_edits_inside_the_range_hold_the_accept(ws, window) -> None:
    def add(project: EpisodeProject) -> None:
        project.editorial.edit_decisions.append(
            EditDecision(
                id="inside",
                track_id="host",
                type=EditDecisionType.MUTE,
                start=window[0],
                end=window[1],
                timebase="timeline",
                applied=False,
            )
        )

    ws.mutate("decision", "decided", add)
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    before = _everything(ws)
    with pytest.raises(CodedValueError, match="1 pending edit sits inside") as refused:
        SessionSuggestionService(ws).accept(sid)
    assert refused.value.code == "pending_edits_in_range"
    assert _everything(ws) == before


def test_the_chosen_takes_live_comments_land_at_the_range_start(ws) -> None:
    sid = _stage_replace(
        ws,
        2.0,
        4.0,
        {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]},
        comments={0: [("a", 100)], 1: [("b", 1500), ("c", 250)]},
    )
    result = SessionSuggestionService(ws).accept(sid, take_index=1)
    ws.reload()
    placed = {c.id: c.timeline_start for c in ws.project.comments}
    assert placed == {"live-1-0": pytest.approx(3.5), "live-1-1": pytest.approx(2.25)}
    assert result["comments_not_placed"] == 1


def test_undo_restores_the_pending_session_and_redo_replays_it(ws) -> None:
    _words(ws, "host", ("hello", 2.5, 2.9))
    _comments(ws)
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    before = _everything(ws)
    transcripts = json.dumps([t.model_dump() for t in ws.project.transcripts], default=str)
    SessionSuggestionService(ws).accept(sid)
    accepted = _everything(ws)
    assert accepted != before
    history = HistoryService(ws)
    history.undo()
    assert _everything(ws) == before
    row = _suggestion_row(ws)
    assert (row.status, row.selected_take) == ("pending", None)
    assert json.dumps([t.model_dump() for t in ws.project.transcripts], default=str) == transcripts
    history.redo()
    assert _everything(ws) == accepted


def test_a_decided_session_cannot_be_accepted_again(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    service = SessionSuggestionService(ws)
    service.accept(sid)
    done = _everything(ws)
    with pytest.raises(CodedValueError, match="was already accepted") as again:
        service.accept(sid)
    assert again.value.code == "session_suggestion_not_pending"
    assert _everything(ws) == done
    HistoryService(ws).undo()
    service.skip(sid)
    with pytest.raises(CodedValueError) as skipped:
        service.accept(sid)
    assert skipped.value.code == "session_suggestion_not_pending"


def test_the_combined_transcript_is_rebuilt_once(ws) -> None:
    _words(ws, "host", ("hello", 2.5, 2.9))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)]})
    calls: list[int] = []

    def counted(*args, **kwargs):
        calls.append(1)

    with (
        patch("podcast_mcp.edits.session_suggestions.rebuild_combined", counted),
        patch("podcast_mcp.engines.transcript_sync.rebuild_combined", counted),
    ):
        SessionSuggestionService(ws).accept(sid)
    assert len(calls) == 1


def test_a_pending_insert_whose_audio_was_replaced_goes_stale_at_its_own_accept(ws) -> None:
    room, _guest, _svc, _landed = _stage(ws, {"kind": "insert", "at_sec": 3.0})
    replace = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]}, session_id="c" * 12, number=2)
    SessionSuggestionService(ws).accept(replace)
    _stale(ws, f"ss-{room['session_id']}")


def test_a_replace_staged_by_landing_captures_its_anchors_and_accepts(ws) -> None:
    from podcast_mcp.engines.track_ids import slug_track_id

    room = ShareService(ws).create_record_room()
    svc, guest = _join(ws, room)
    track = slug_track_id(guest)

    def seed(project: EpisodeProject) -> None:
        project.tracks.append(Track(id=track, label="Ava", role=TrackRole.DIALOGUE))
        project.clips.append(
            Clip(
                id="gc",
                track_id=track,
                source_id="src-gc",
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )

    ws.mutate("seed", "seeded", seed)
    target = {"kind": "replace", "from_sec": 0.5, "to_sec": 2.0, "track_ids": [track]}
    svc.submit(_cmd("SetTarget", payload={"target": target}), now_wall_ms=0)
    _record(ws, room, svc, guest, 1)
    RecordLandingService(ws).land(align=lambda _p: None)
    row = _suggestion(ws, room["session_id"])
    assert row.anchor is not None and row.end_anchor is not None
    assert (row.anchor.track_id, row.anchor.source_sec, row.anchor.side) == (track, 0.5, "before")
    assert (row.end_anchor.track_id, row.end_anchor.source_sec) == (track, 2.0)
    before = _everything(ws)
    result = SessionSuggestionService(ws).accept(f"ss-{room['session_id']}")
    assert (result["from_sec"], result["to_sec"]) == (0.5, 2.0)
    assert result["delta_s"] == pytest.approx(-1.0)
    assert _end(ws) == pytest.approx(9.0)
    HistoryService(ws).undo()
    assert _everything(ws) == before


def _project_with_comment_and_words(ws) -> EpisodeProject:
    _comments(ws)
    _words(ws, "host", ("hello", 2.5, 2.9))
    ws.reload()
    return ws.project


def test_other_callers_of_the_removal_primitive_still_remap_and_rebuild(ws) -> None:
    project = _project_with_comment_and_words(ws)
    removal = RippleRemoval.of([TrackExtent("host", 2.0, 4.0)])
    calls: list[int] = []
    with patch(
        "podcast_mcp.engines.transcript_sync.rebuild_combined", lambda *a, **k: calls.append(1)
    ):
        _write_ripple_delete(project, removal, defaults=ws.effective_config())
    assert len(calls) == 1
    assert "inside" not in {c.id for c in project.comments}
    assert [c.time for c in project.editorial.chapters] == [1.0, 2.0, 2.0, 4.0]


def test_the_public_range_removal_keeps_comments_and_rebuilds_only_when_asked(ws) -> None:
    project = _project_with_comment_and_words(ws)
    removal = RippleRemoval.of([TrackExtent("host", 2.0, 4.0)])
    calls: list[int] = []
    with patch(
        "podcast_mcp.engines.transcript_sync.rebuild_combined", lambda *a, **k: calls.append(1)
    ):
        ripple_delete_range(project, removal, defaults=ws.effective_config())
    assert calls == []
    assert "inside" in {c.id for c in project.comments}
    assert len(project.editorial.chapters) == 5


def test_cli_and_mcp_choose_a_take_and_confirm_a_hold(ws, minimal_project) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]})
    runner = CliRunner()
    base = ["review", "accept-session-suggestion", "--project", str(minimal_project), "--id", sid]
    held = runner.invoke(cli_app, [*base, "--take", "0"])
    assert held.exit_code == 1
    assert 'Replacing this range also removes 1 word from Guest: "so".' in held.output
    assert "--override-audio-checks" in held.output
    ws.reload()
    assert _suggestion_row(ws).status == "pending"
    done = runner.invoke(cli_app, [*base, "--take", "0", "--override-audio-checks"])
    assert done.exit_code == 0, done.output
    assert json.loads(done.output)["take_index"] == 0
    ws.reload()
    [record] = ws.project.editorial.edit_log
    assert record.params[OVERRIDE_PARAM]["surface"] == "cli"
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    asked = json.loads(accept_session_suggestion_tool(str(minimal_project), sid, take_index=1))
    assert asked["unchanged"] is True
    assert "override_audio_checks=true" in asked["needs_confirmation"]["message"]
    applied = json.loads(
        accept_session_suggestion_tool(
            str(minimal_project), sid, take_index=1, override_audio_checks=True
        )
    )
    assert applied["take_index"] == 1


def _speech(*tracks):
    from podcast_mcp.models import CutSpeech, CutSpeechTrack, CutSpeechWord
    from podcast_mcp.models.episode import RangeInterval

    return CutSpeech(
        spans=[RangeInterval(start=0.0, end=9.0)],
        tracks=[
            CutSpeechTrack(
                track_id=tid,
                speaker=speaker,
                words=[
                    CutSpeechWord(
                        text=w, timeline_start=start + i * 0.1, timeline_end=start + i * 0.1 + 0.05
                    )
                    for i, w in enumerate(words)
                ],
                sound_spans=[RangeInterval(start=start, end=start + 1.0)] if sound else [],
            )
            for tid, speaker, words, start, sound in tracks
        ],
    )


def _hold_message(*tracks) -> str:
    from podcast_mcp.edits.cut_speech import replace_confirmation_for

    return replace_confirmation_for(_speech(*tracks)).message


_TAIL = " Replace anyway to apply it; undo brings it back."


def test_replace_hold_names_one_track_and_quotes_its_words() -> None:
    message = _hold_message(("t1", "Daniela", ["and", "I", "think", "that"], 1.0, False))
    assert message == (
        'Replacing this range also removes 4 words from Daniela: "and I think that".' + _TAIL
    )


def test_replace_hold_joins_tracks_in_time_order() -> None:
    message = _hold_message(
        ("t2", "Guest", ["so", "plan"], 3.0, False),
        ("t1", "Daniela", ["hi"], 1.0, False),
    )
    assert message == (
        'Replacing this range also removes 1 word from Daniela: "hi" and '
        '2 words from Guest: "so plan".' + _TAIL
    )
    three = _hold_message(
        ("t1", "A", ["a"], 1.0, False),
        ("t2", "B", ["b"], 2.0, False),
        ("t3", "C", ["c"], 3.0, False),
    )
    assert 'from A: "a", 1 word from B: "b" and 1 word from C: "c".' in three


def test_replace_hold_counts_what_it_does_not_quote() -> None:
    words = list("abcdefghijklmnopqrst")
    message = _hold_message(("t1", "Daniela", words, 1.0, False))
    assert message == (
        'Replacing this range also removes 20 words from Daniela: "a b c d e f g h" '
        "…and 12 more." + _TAIL
    )


def test_replace_hold_names_sound_without_words() -> None:
    message = _hold_message(("t1", "Daniela", [], 1.0, True))
    assert message == "Replacing this range also removes sound from Daniela." + _TAIL
