"""A lane recorded as two takes: every word of both transcripts gets its own verdict (#1470)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.audio_quality import suppress_bleed_words
from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCacheSet,
    compute_word_audibility_map,
)
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.lane_words import lane_transcripts, requested_word_keys
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

# Take 2 plays at timeline 0-10 s from its own 0-10 s; take 3 plays at 10-30 s from its
# own 0-20 s. Dani's mic is loud only at timeline 14-16 s, where it bleeds into Vicky's.
_DANI_LOUD = (14.0, 16.0)


def _words(prefix: str, starts: list[float]) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=f"{prefix}{n}", start=s, end=s + 0.4, confidence=0.9)
        for n, s in enumerate(starts)
    ]


def _two_take_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("vicky", "dani")
    ]
    project.clips = [
        Clip(
            id="c2",
            track_id="vicky",
            source_id="take2",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c3",
            track_id="vicky",
            source_id="take3",
            source_start=0.0,
            source_end=20.0,
            timeline_start=10.0,
        ),
        Clip(id="cd", track_id="dani", source_start=0.0, source_end=30.0, timeline_start=0.0),
    ]
    project.transcripts = [
        Transcript(track_id="vicky", source_id="take2", words=_words("a", [1.0, 4.5])),
        # Take 3 has more words than take 2; its word 1 (source 4.5 s) plays at 14.5 s.
        Transcript(
            track_id="vicky", source_id="take3", words=_words("b", [1.0, 4.5, 8.0, 12.0, 18.0])
        ),
        Transcript(track_id="dani", words=_words("d", [14.5])),
    ]
    return project


def _level(project, track_id, t0, t1, **_kw) -> float:
    if track_id == "dani":
        return -20.0 if _DANI_LOUD[0] <= t0 < _DANI_LOUD[1] else -70.0
    return -32.0


def _path(source: str, bleed: str) -> EchoPairProfile:
    return EchoPairProfile(
        source_track_id=source,
        bleed_track_id=bleed,
        span_start=0.0,
        span_end=30.0,
        dominated_frames=100,
        copy_frames=40,
        consistent_frames=30,
        lag_ms=0.0,
        level_db=-18.0,
        examples=(14.5,),
        null_runs=8,
        null_copy_rate=0.05,
        null_consistent_rate=0.02,
    )


@pytest.fixture
def measured_session():
    with (
        patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_level),
        patch(
            "podcast_mcp.engines.audio_audit.TrackRmsCacheSet.echo_pairs",
            new=lambda self: [_path("dani", "vicky")],
        ),
    ):
        yield


def _statuses(project: EpisodeProject, source_id: str) -> list[str | None]:
    tr = project.transcript_by_key(("vicky", source_id))
    assert tr is not None
    return [w.audibility_status for w in tr.words]


def test_every_word_of_both_takes_gets_its_own_row(tmp_path: Path, measured_session) -> None:
    project = _two_take_project(tmp_path)

    rows = compute_word_audibility_map(project, track_id="vicky", policy=AnalysisPolicy())

    by_take = {
        source: [r["audibility_status"] for r in rows if r["source_id"] == source]
        for source in ("take2", "take3")
    }
    assert by_take == {
        "take2": ["audible", "audible"],
        "take3": ["audible", "bleed", "audible", "audible", "audible"],
    }


def test_reconcile_writes_each_take_from_its_own_rows(tmp_path: Path, measured_session) -> None:
    project = _two_take_project(tmp_path)

    with patch(
        "podcast_mcp.engines.transcript_reconcile.build_reconciliation_caches",
        return_value=TrackRmsCacheSet(),
    ):
        result = reconcile_transcript(project, policy=AnalysisPolicy(), dry_run=False)

    # Take 3's word 1 is Dani's bleed; take 2's word 1 stays Vicky's own speech.
    assert _statuses(project, "take2") == ["audible", "audible"]
    assert _statuses(project, "take3") == ["audible", "bleed", "audible", "audible", "audible"]
    assert [(e["source_id"], e["word_index"]) for e in result.suppress] == [("take3", 1)]
    assert project.transcript_by_key(("vicky", "take2")).words[1].suppressed is False


def test_overlap_pairs_compare_takes_on_the_session_clock(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    report = overlap_duplicate_report(project, audibility=[])

    # Only take 3's word 1 (source 4.5 s, timeline 14.5 s) overlaps Dani's word; take 2's
    # word 1 shares its source time but plays 10 s earlier.
    assert [(p["source_b"], p["word_index_b"], p["session_start_b"]) for p in report["pairs"]] == [
        ("take3", 1, 14.5)
    ]


def test_lane_transcripts_read_each_take_at_its_placement(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    lanes = lane_transcripts(project, "vicky")

    assert [(lt.key, lt.session_offset) for lt in lanes] == [
        (("vicky", "take2"), 0.0),
        (("vicky", "take3"), 10.0),
    ]


def test_a_bare_word_index_on_a_two_take_lane_names_no_word(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    with pytest.raises(ValueError, match="give each word's source_id"):
        requested_word_keys(project, [{"track_id": "vicky", "word_index": 1}])
    assert requested_word_keys(project, [{"track_id": "dani", "word_index": 0}]) == {
        ("dani", None, 0)
    }


def test_explicit_suppression_touches_only_the_named_take(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    suppress_bleed_words(
        project,
        word_keys=[{"track_id": "vicky", "source_id": "take3", "word_index": 1}],
        dry_run=False,
    )

    take2 = project.transcript_by_key(("vicky", "take2"))
    take3 = project.transcript_by_key(("vicky", "take3"))
    assert take2 is not None and take3 is not None
    assert [w.suppressed for w in take2.words] == [False, False]
    assert [w.suppressed for w in take3.words] == [False, True, False, False, False]
