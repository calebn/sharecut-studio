"""A lane recorded as two takes: every word of both transcripts gets its own verdict (#1470)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.audio_quality import suppress_bleed_words, suppress_low_audibility_words
from podcast_mcp.edits.bleed_text_match import EchoTwinPath, _echo_twin_losers
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
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.coded_error import CodedValueError

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

    rows = compute_word_audibility_map(
        project, track_id="vicky", policy=AnalysisPolicy(), defaults=load_defaults()
    )

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
        result = reconcile_transcript(
            project, policy=AnalysisPolicy(), dry_run=False, defaults=load_defaults()
        )

    # Take 3's word 1 is Dani's bleed; take 2's word 1 stays Vicky's own speech.
    assert _statuses(project, "take2") == ["audible", "audible"]
    assert _statuses(project, "take3") == ["audible", "bleed", "audible", "audible", "audible"]
    assert [(e["source_id"], e["word_index"]) for e in result.suppress] == [("take3", 1)]
    assert project.transcript_by_key(("vicky", "take2")).words[1].suppressed is False


def test_overlap_pairs_compare_takes_on_the_session_clock(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    report = overlap_duplicate_report(project, audibility=[], defaults=load_defaults())

    # Only take 3's word 1 (source 4.5 s, timeline 14.5 s) overlaps Dani's word; take 2's
    # word 1 shares its source time but plays 10 s earlier.
    assert [(p["source_b"], p["word_index_b"], p["session_start_b"]) for p in report["pairs"]] == [
        ("take3", 1, 14.5)
    ]


def test_lane_transcripts_read_each_take_at_its_placement(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    lanes = lane_transcripts(project, "vicky")

    assert [(lt.key, lt.session_span(4.5, 4.9)) for lt in lanes] == [
        (("vicky", "take2"), (4.5, 4.9)),
        (("vicky", "take3"), (14.5, 14.9)),
    ]


def test_a_teaser_clip_does_not_move_the_rest_of_its_lane(tmp_path: Path) -> None:
    """A cold-open teaser replays source 600-610 s at 0 s; the take's main placement
    still reads its words at source + 10 s, where the guest's twins sit."""
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(id="t", track_id="host", source_start=600.0, source_end=610.0, timeline_start=0.0),
        Clip(id="h", track_id="host", source_start=0.0, source_end=900.0, timeline_start=10.0),
        Clip(id="g", track_id="guest", source_start=0.0, source_end=900.0, timeline_start=10.0),
    ]
    project.transcripts = [
        Transcript(track_id="host", words=_words("hello", [100.0, 605.0])),
        Transcript(track_id="guest", words=_words("hello", [100.0])),
    ]

    (host,) = lane_transcripts(project, "host")
    report = overlap_duplicate_report(project, audibility=[], defaults=load_defaults())

    assert [host.session_span(100.0, 100.4)[0], host.session_span(605.0, 605.4)[0]] == [
        110.0,
        615.0,
    ]
    assert [(p["word_index_a"], p["word_index_b"]) for p in report["pairs"]] == [(0, 0)]


def test_a_bare_word_index_on_a_two_take_lane_names_no_word(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    with pytest.raises(CodedValueError, match="give each word's source_id") as refusal:
        requested_word_keys(project, [{"track_id": "vicky", "word_index": 1}])
    assert refusal.value.code == "word_source_required"
    assert requested_word_keys(project, [{"track_id": "dani", "word_index": 0}]) == {
        ("dani", None, 0)
    }


def test_explicit_suppression_touches_only_the_named_take(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    suppress_bleed_words(
        project,
        word_keys=[{"track_id": "vicky", "source_id": "take3", "word_index": 1}],
        dry_run=False,
        defaults=load_defaults(),
    )

    take2 = project.transcript_by_key(("vicky", "take2"))
    take3 = project.transcript_by_key(("vicky", "take3"))
    assert take2 is not None and take3 is not None
    assert [w.suppressed for w in take2.words] == [False, False]
    assert [w.suppressed for w in take3.words] == [False, True, False, False, False]


def _cut_project(tmp_path: Path, host_clips: list[Clip], guest_clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("host", "guest")
    ]
    project.clips = [*host_clips, *guest_clips]
    return project


def test_a_word_ending_at_a_ripple_cut_keeps_its_length(tmp_path: Path) -> None:
    """Both lanes lose source 10.4-12.4 s; a word ending at the cut stays one 0.4 s word."""

    def lane(tid: str) -> list[Clip]:
        return [
            Clip(id=f"{tid}1", track_id=tid, source_start=0.0, source_end=10.4, timeline_start=0.0),
            Clip(
                id=f"{tid}2", track_id=tid, source_start=12.4, source_end=900.0, timeline_start=10.4
            ),
        ]

    project = _cut_project(tmp_path, lane("host"), lane("guest"))
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hello", start=10.0, end=10.4)]),
        Transcript(track_id="guest", words=[TranscriptWord(text="hello", start=10.02, end=10.4)]),
    ]

    (host,) = lane_transcripts(project, "host")
    report = overlap_duplicate_report(project, audibility=[], defaults=load_defaults())

    assert host.session_span(10.0, 10.4) == (10.0, 10.4)
    assert [(p["text_match"], p["overlap_sec"]) for p in report["pairs"]] == [(True, 0.38)]


def test_a_gap_after_a_word_does_not_stretch_it_onto_a_later_peer_word(tmp_path: Path) -> None:
    """A 5 s gap inserted after the host's word leaves it at 10.0-10.4 s, not 10.0-15.4 s."""
    project = _cut_project(
        tmp_path,
        [
            Clip(id="h1", track_id="host", source_start=0.0, source_end=10.4, timeline_start=0.0),
            Clip(
                id="h2", track_id="host", source_start=10.4, source_end=900.0, timeline_start=15.4
            ),
        ],
        [Clip(id="g", track_id="guest", source_start=0.0, source_end=900.0, timeline_start=0.0)],
    )
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="the", start=10.0, end=10.4)]),
        Transcript(track_id="guest", words=[TranscriptWord(text="the", start=13.0, end=13.3)]),
    ]

    assert overlap_duplicate_report(project, audibility=[], defaults=load_defaults())["pairs"] == []


def test_a_word_no_clip_plays_has_no_session_time(tmp_path: Path) -> None:
    """Vicky's source 10-30 s is ripple-cut away; her 'yeah' at 20 s is never heard, so it
    cannot twin Dani's 'yeah' that plays at 0.05 s."""
    project = _cut_project(
        tmp_path,
        [
            Clip(id="v1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
            Clip(id="v2", track_id="host", source_start=30.0, source_end=60.0, timeline_start=10.0),
        ],
        [Clip(id="d1", track_id="guest", source_start=0.0, source_end=40.0, timeline_start=0.0)],
    )
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="yeah", start=20.0, end=20.3)]),
        Transcript(track_id="guest", words=[TranscriptWord(text="yeah", start=0.05, end=0.35)]),
    ]

    (host,) = lane_transcripts(project, "host")

    assert host.session_span(20.0, 20.3) is None
    assert overlap_duplicate_report(project, audibility=[], defaults=load_defaults())["pairs"] == []
    losers = _echo_twin_losers(
        project,
        EchoTwinPath("host", "guest", 0.0),
        policy=AnalysisPolicy(),
        is_suppressed=None,
        seen=set(),
    )
    assert losers == []


def _same_recording_project(tmp_path: Path) -> EpisodeProject:
    """Vicky's primary media and source S are one file: clip c1 plays it as implicit
    primary media, clip c2 as source S."""
    project = EpisodeProject.create("ep", str(tmp_path))
    (tmp_path / "a.wav").write_bytes(b"x")
    project.timeline.tracks = [
        Track(
            id="vicky",
            label="vicky",
            role=TrackRole.DIALOGUE,
            speaker="vicky",
            media=MediaAsset(path=str(tmp_path / "a.wav")),
        ),
        Track(id="dani", label="dani", role=TrackRole.DIALOGUE, speaker="dani"),
    ]
    project.sources = [SourceRecording(id="S", path=str(tmp_path / "a.wav"))]
    project.clips = [
        Clip(id="c1", track_id="vicky", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(
            id="c2",
            track_id="vicky",
            source_id="S",
            source_start=20.0,
            source_end=30.0,
            timeline_start=100.0,
        ),
        Clip(id="cd", track_id="dani", source_start=0.0, source_end=200.0, timeline_start=0.0),
    ]
    project.transcripts = [
        Transcript(track_id="vicky", words=_words("hello", [25.0])),
        Transcript(track_id="dani", words=_words("hello", [105.0])),
    ]
    return project


def test_clips_naming_one_recording_two_ways_all_place_its_transcript(tmp_path: Path) -> None:
    project = _same_recording_project(tmp_path)

    (vicky,) = lane_transcripts(project, "vicky")
    report = overlap_duplicate_report(project, audibility=[], defaults=load_defaults())

    assert vicky.session_span(25.0, 25.4) == (105.0, 105.4)
    assert [(p["word_index_a"], p["word_index_b"]) for p in report["pairs"]] == [(0, 0)]


def test_a_source_id_naming_the_primary_recording_addresses_its_words(tmp_path: Path) -> None:
    project = _same_recording_project(tmp_path)

    assert requested_word_keys(
        project, [{"track_id": "vicky", "source_id": "S", "word_index": 0}]
    ) == {("vicky", None, 0)}
    with pytest.raises(CodedValueError, match="no transcript for source"):
        requested_word_keys(project, [{"track_id": "vicky", "source_id": "nope", "word_index": 0}])


def test_an_explicit_low_audibility_list_touches_only_the_named_take(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)

    suppress_low_audibility_words(
        project,
        word_keys=[{"track_id": "vicky", "source_id": "take2", "word_index": 0}],
        defaults=load_defaults(),
    )

    take2 = project.transcript_by_key(("vicky", "take2"))
    take3 = project.transcript_by_key(("vicky", "take3"))
    assert take2 is not None and take3 is not None
    assert [w.suppressed for w in take2.words] == [True, False]
    assert not any(w.suppressed for w in take3.words)


def test_a_word_that_starts_before_its_clip_is_placed_where_it_plays(tmp_path: Path) -> None:
    project = _cut_project(
        tmp_path,
        [Clip(id="v", track_id="host", source_start=5.0, source_end=10.0, timeline_start=0.0)],
        [Clip(id="d", track_id="guest", source_start=0.0, source_end=10.0, timeline_start=0.0)],
    )
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="x", start=4.9, end=5.3)]),
        Transcript(track_id="guest", words=[TranscriptWord(text="x", start=0.0, end=0.3)]),
    ]

    (host,) = lane_transcripts(project, "host")
    windowed = overlap_duplicate_report(
        project, audibility=[], start_sec=0.0, defaults=load_defaults()
    )

    assert host.session_span(4.9, 5.3) == pytest.approx((0.0, 0.3))
    assert len(windowed["pairs"]) == 1
