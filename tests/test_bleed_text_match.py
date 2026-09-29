from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.bleed_text_match import (
    EchoTwinPath,
    _audibility_score,
    _pick_text_match_winner,
    _word_confidence,
    echo_twin_path,
    echo_twin_paths,
    overlap_text_match_losers,
)
from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report, run_reconciliation
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _two_track_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    for tid, speaker in (("host", "Host"), ("guest", "Guest")):
        raw = tmp_path / "raw" / f"{tid}.wav"
        raw.parent.mkdir(exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c-{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="world", start=1.0, end=1.5, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="world", start=1.0, end=1.5, confidence=0.85),
            ],
        ),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    return project


def _equal_rms(project, track_id, t_start, t_end, **kwargs):
    return -35.0


def test_audibility_score_ranks_statuses() -> None:
    assert _audibility_score("audible") > _audibility_score("bleed")
    assert _audibility_score("deferred") > _audibility_score("inaudible")
    assert _audibility_score("bleed") > _audibility_score("inaudible")
    assert _audibility_score(None) == 1


def test_pick_text_match_winner_audibility_margin() -> None:
    pair = {
        "track_a": "host",
        "track_b": "guest",
        "status_a": "audible",
        "status_b": "bleed",
        "confidence_a": 0.9,
        "confidence_b": 0.9,
    }
    assert _pick_text_match_winner(pair) == "host"


def test_pick_text_match_winner_confidence_and_default() -> None:
    tie = {
        "track_a": "host",
        "track_b": "guest",
        "status_a": "audible",
        "status_b": "audible",
        "confidence_a": 0.95,
        "confidence_b": 0.8,
        "rms_a_db": -35.0,
        "rms_b_db": -35.2,
    }
    assert _pick_text_match_winner(tie) == "host"
    assert _pick_text_match_winner({**tie, "confidence_a": 0.9, "confidence_b": 0.9}) == "host"


def test_pick_text_match_winner_prefers_rms_tiebreak() -> None:
    pair = {
        "track_a": "host",
        "track_b": "guest",
        "status_a": "audible",
        "status_b": "audible",
        "confidence_a": 0.9,
        "confidence_b": 0.9,
        "rms_a_db": -30.0,
        "rms_b_db": -35.0,
    }
    assert _pick_text_match_winner(pair) == "host"


def test_text_match_min_dominance_skips_close_rms(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(
        bleed_text_match_enabled=True,
        bleed_text_match_min_dominance_db=3.0,
    )

    def close_rms(project, track_id, t_start, t_end, **kwargs):
        return -35.0 if track_id == "host" else -36.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=close_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
    assert losers == []


def test_text_match_overlap_names_loser_without_writing(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)

    assert losers == [
        {
            "track_id": "guest",
            "word_index": 0,
            "text": "world",
            "start": 1.0,
            "end": 1.5,
            "audibility_status": "bleed",
            "dominant_track": "host",
            "reason": "text_match_overlap",
        }
    ]
    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[0].suppressed is False
    assert guest.words[0].audibility_status is None


def test_text_match_loser_follows_the_callers_suppression_verdict(tmp_path: Path) -> None:
    """Reconcile passes its acoustic verdict: a stored-suppressed word it is about to
    unsuppress can still lose, and a word it is about to suppress drops out of the pairs."""
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words[0] = guest.words[0].model_copy(update={"suppressed": True})
    pol = AnalysisPolicy(bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        stored = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
        by_verdict = overlap_text_match_losers(
            project, policy=pol, is_suppressed=lambda tid, i: False, echo_pairs=_ROOM_PAIR
        )
        host_gone = overlap_text_match_losers(
            project,
            policy=pol,
            is_suppressed=lambda tid, i: tid == "host",
            echo_pairs=_ROOM_PAIR,
        )

    assert stored == []
    assert [(e["track_id"], e["word_index"], e["dominant_track"]) for e in by_verdict] == [
        ("guest", 0, "host")
    ]
    assert host_gone == []


def test_text_match_skips_locked_loser(tmp_path: Path) -> None:
    """A word a person/agent already decided to keep audible stays unsuppressed (#768)."""
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words[0] = guest.words[0].model_copy(update={"audibility_locked": True})
    pol = AnalysisPolicy(bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)

    assert losers == []


def test_text_match_guest_wins_when_louder(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)

    def guest_louder(project, track_id, t_start, t_end, **kwargs):
        return -28.0 if track_id == "guest" else -38.0

    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=guest_louder,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)

    assert [(e["track_id"], e["word_index"], e["dominant_track"]) for e in losers] == [
        ("host", 1, "guest")
    ]


def test_text_match_min_overlap_skips_short_overlap(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words[0] = guest.words[0].model_copy(update={"start": 1.0, "end": 1.02})
    pol = AnalysisPolicy(
        bleed_text_match_enabled=True,
        bleed_text_match_min_overlap_sec=0.05,
    )
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
    assert losers == []


def test_word_confidence_defaults_when_missing(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    assert _word_confidence(project, "missing", 0) == 1.0
    assert _word_confidence(project, "host", 99) == 1.0


def test_text_match_min_dominance_ignored_when_rms_missing(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(
        bleed_text_match_enabled=True,
        bleed_text_match_min_dominance_db=3.0,
    )

    def no_rms(project, track_id, t_start, t_end, **kwargs):
        return None

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=no_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
    assert len(losers) == 1


def test_text_match_skips_anomalous_word_duration(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    guest = project.transcript_for_track("guest")
    assert host is not None and guest is not None
    host.words[1] = host.words[1].model_copy(update={"end": 12.0})
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
    assert losers == []


def test_text_match_disabled_skips_suppression(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=False)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
    assert losers == []
    report = overlap_duplicate_report(project)
    assert report["text_match_count"] == 1


def test_reconcile_applies_text_match_suppression(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    with (
        patch(
            "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
            side_effect=_equal_rms,
        ),
        patch(
            "podcast_mcp.engines.audio_audit.TrackRmsCacheSet.echo_pairs",
            new=lambda self: _ROOM_PAIR,
        ),
    ):
        run_reconciliation(project, dry_run=False)

    report = overlap_duplicate_report(project)
    assert report["text_match_count"] == 0
    host_text = " ".join(
        u.text for u in project.combined_transcript.utterances if u.track_id == "host"
    )
    assert "world" in host_text
    guest_text = " ".join(
        u.text for u in project.combined_transcript.utterances if u.track_id == "guest"
    )
    assert "world" not in guest_text


def _echo_profile(source: str, bleed: str, *, lag_ms: float = 3.0) -> EchoPairProfile:
    """A bleed_echo verdict as reconcile receives it: ``bleed`` carries ``source``."""
    return EchoPairProfile(
        source_track_id=source,
        bleed_track_id=bleed,
        span_start=0.0,
        span_end=20.0,
        dominated_frames=200,
        copy_frames=80,
        consistent_frames=60,
        lag_ms=lag_ms,
        level_db=-18.0,
        examples=(1.0,),
        null_runs=8,
        null_copy_rate=0.05,
        null_consistent_rate=0.02,
    )


# A room pair with bleed both ways: no single source, so the loudness rule applies.
_ROOM_PAIR = [_echo_profile("host", "guest"), _echo_profile("guest", "host")]


def _words(*specs: tuple[str, float, float]) -> list[TranscriptWord]:
    return [TranscriptWord(text=t, start=s, end=s + d, confidence=c) for t, s, d, c in specs]


def _echo_project(
    tmp_path: Path, *, host: list[TranscriptWord], guest: list[TranscriptWord]
) -> EpisodeProject:
    project = _two_track_project(tmp_path)
    project.transcripts = [
        Transcript(track_id="host", words=host),
        Transcript(track_id="guest", words=guest),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    return project


# Six guest words and the host mic's Whisper copies 130-160 ms *earlier*, as on a Zoom
# host track that picks up a network-delayed participant (#774), plus one stray twin.
_GUEST_SIX = [
    ("one", 1.0, 0.3, 0.9),
    ("two", 2.0, 0.3, 0.9),
    ("three", 3.0, 0.3, 0.9),
    ("four", 4.0, 0.3, 0.9),
    ("five", 5.0, 0.3, 0.9),
    ("six", 6.0, 0.3, 0.9),
]
_HOST_COPIES = [
    ("one", 0.86, 0.3, 1.0),
    ("two", 1.87, 0.3, 1.0),
    ("three", 2.85, 0.3, 1.0),
    ("four", 3.86, 0.3, 1.0),
    ("five", 4.84, 0.3, 1.0),
    ("six", 5.86, 0.3, 1.0),
]


def test_echo_twin_path_takes_its_lag_from_the_twins_or_the_acoustic_measurement(
    tmp_path: Path,
) -> None:
    project = _echo_project(
        tmp_path,
        host=_words(*_HOST_COPIES, ("one", 1.3, 0.3, 1.0)),
        guest=_words(*_GUEST_SIX),
    )
    path = echo_twin_path(project, _echo_profile("guest", "host"))
    assert path.source_track_id == "guest"
    assert path.bleed_track_id == "host"
    assert path.lag_sec == pytest.approx(-0.14)
    assert path.tolerance_sec == 0.15
    assert path.twins == 6
    assert path.is_twin(1.0, 0.86) is True
    assert path.is_twin(1.0, 1.3) is False

    few = _echo_project(tmp_path, host=_words(*_HOST_COPIES[:2]), guest=_words(*_GUEST_SIX))
    assert echo_twin_path(few, _echo_profile("guest", "host", lag_ms=3.0)) == EchoTwinPath(
        "guest", "host", 0.003, 0.15, 0
    )


def test_echo_twin_paths_skip_a_pair_flagged_in_both_directions(tmp_path: Path) -> None:
    project = _echo_project(tmp_path, host=_words(*_HOST_COPIES), guest=_words(*_GUEST_SIX))
    one_way = echo_twin_paths(project, [_echo_profile("guest", "host")])
    assert [(p.source_track_id, p.bleed_track_id) for p in one_way] == [("guest", "host")]
    both = echo_twin_paths(
        project, [_echo_profile("guest", "host"), _echo_profile("host", "guest")]
    )
    assert both == []


def test_echo_pair_copy_loses_to_the_source_whatever_its_loudness(tmp_path: Path) -> None:
    """On the lab tape Zoom's gain brought caleb's copy of audra's "that's" 1 dB above her
    own mic, and the loudness rule kept the copy. With a measured path the copy loses."""
    project = _echo_project(tmp_path, host=_words(*_HOST_COPIES), guest=_words(*_GUEST_SIX))
    pol = AnalysisPolicy(bleed_text_match_enabled=True)

    def host_louder(project, track_id, t_start, t_end, **kwargs):
        return -24.0 if track_id == "host" else -25.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=host_louder,
    ):
        by_loudness = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
        by_path = overlap_text_match_losers(
            project, policy=pol, echo_pairs=[_echo_profile("guest", "host")]
        )

    assert [(e["track_id"], e["word_index"]) for e in by_loudness] == [
        ("guest", i) for i in range(6)
    ]
    assert by_path == [
        {
            "track_id": "host",
            "word_index": i,
            "text": text,
            "start": start,
            "end": pytest.approx(start + 0.3),
            "audibility_status": "bleed",
            "dominant_track": "guest",
            "reason": "echo_twin",
        }
        for i, (text, start, _dur, _conf) in enumerate(_HOST_COPIES)
    ]


def test_echo_pair_identical_words_at_another_spacing_are_two_people(tmp_path: Path) -> None:
    """Three people saying "Bye." together: the copies land at the path's lag, a second
    speaker's own word does not, so it stays even though it overlaps and is quieter."""
    project = _echo_project(
        tmp_path,
        host=_words(*_HOST_COPIES, ("bye", 8.3, 0.4, 1.0), ("okay", 9.0, 0.3, 1.0)),
        guest=_words(*_GUEST_SIX, ("bye", 8.0, 0.4, 0.9), ("okay", 9.4, 0.3, 0.9)),
    )
    pol = AnalysisPolicy(bleed_text_match_enabled=True)

    def guest_louder(project, track_id, t_start, t_end, **kwargs):
        return -30.0 if track_id == "host" else -26.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=guest_louder,
    ):
        losers = overlap_text_match_losers(
            project, policy=pol, echo_pairs=[_echo_profile("guest", "host")]
        )

    assert [(e["track_id"], e["word_index"], e["reason"]) for e in losers] == [
        ("host", i, "echo_twin") for i in range(6)
    ]


def test_identical_words_on_a_pair_with_no_bleed_path_both_stay(tmp_path: Path) -> None:
    """Two mics with no measured path saying the same word at the same time are two
    people, not a duplicate: the lab's remote participant and the co-host both said
    "Bye." and the loudness rule dropped one of them (#774)."""
    project = _echo_project(
        tmp_path,
        host=_words(("bye", 8.0, 0.4, 1.0)),
        guest=_words(("bye", 8.0, 0.4, 0.9)),
    )
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        no_path = overlap_text_match_losers(project, policy=pol)
        room = overlap_text_match_losers(project, policy=pol, echo_pairs=_ROOM_PAIR)
        other_pair = overlap_text_match_losers(
            project, policy=pol, echo_pairs=[_echo_profile("guest", "remote")]
        )
    assert no_path == []
    assert other_pair == []
    assert [(e["track_id"], e["word_index"], e["reason"]) for e in room] == [
        ("guest", 0, "text_match_overlap")
    ]


def test_echo_pair_copy_of_a_suppressed_source_word_is_kept(tmp_path: Path) -> None:
    """When the acoustic verdict already drops the source word (audra's "to" under lana on
    the aligned run), its copy on the bleed mic is the only place the word survives, so
    the twin rule leaves it alone."""
    project = _echo_project(
        tmp_path,
        host=_words(*_HOST_COPIES, ("seven", 6.86, 0.3, 1.0)),
        guest=_words(*_GUEST_SIX, ("seven", 7.0, 0.3, 0.9)),
    )
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(
            project,
            policy=pol,
            echo_pairs=[_echo_profile("guest", "host")],
            is_suppressed=lambda tid, i: tid == "guest" and i == 6,
        )
    assert [(e["track_id"], e["word_index"], e["text"]) for e in losers] == [
        ("host", i, text) for i, (text, _s, _d, _c) in enumerate(_HOST_COPIES)
    ]


def test_echo_pair_copy_that_does_not_overlap_still_loses(tmp_path: Path) -> None:
    """A short word's copy 150 ms early no longer overlaps the source word, which is how
    duplicates survived the overlap rule on the lab tape."""
    project = _echo_project(
        tmp_path,
        host=_words(*_HOST_COPIES, ("the", 7.85, 0.1, 1.0)),
        guest=_words(*_GUEST_SIX, ("the", 8.0, 0.1, 0.9)),
    )
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        losers = overlap_text_match_losers(
            project, policy=pol, echo_pairs=[_echo_profile("guest", "host")]
        )
    assert [(e["track_id"], e["word_index"]) for e in losers] == [("host", i) for i in range(7)]
    assert losers[6]["text"] == "the"
    assert losers[6]["start"] == 7.85
