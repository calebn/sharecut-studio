from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from podcast_mcp.edits.bleed_text_match import (
    _audibility_score,
    _pick_text_match_winner,
    _word_confidence,
    suppress_overlap_text_matches,
)
from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report, run_reconciliation
from podcast_mcp.engines.audio_audit import AnalysisPolicy
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


def test_text_match_track_id_scopes_suppression(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True, track_id="host")
    assert suppressed == []
    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[0].suppressed is False


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
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True)
    assert suppressed == []


def test_text_match_overlap_suppresses_loser(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True)

    assert len(suppressed) == 1
    assert suppressed[0]["track_id"] == "guest"
    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[0].suppressed is True
    assert overlap_duplicate_report(project)["text_match_count"] == 0


def test_text_match_guest_wins_when_louder(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)

    def guest_louder(project, track_id, t_start, t_end, **kwargs):
        return -28.0 if track_id == "guest" else -38.0

    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=guest_louder,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True)

    assert len(suppressed) == 1
    assert suppressed[0]["track_id"] == "host"
    assert suppressed[0]["dominant_track"] == "guest"
    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is True


def test_text_match_min_overlap_and_track_scope(tmp_path: Path) -> None:
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
        suppressed = suppress_overlap_text_matches(
            project, policy=pol, apply=True, track_id="guest"
        )
    assert suppressed == []


def test_word_confidence_defaults_when_missing(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    assert _word_confidence(project, "missing", 0) == 1.0
    assert _word_confidence(project, "host", 99) == 1.0


def test_text_match_end_sec_skips_out_of_window_loser(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True, end_sec=0.5)
    assert suppressed == []


def test_text_match_start_sec_skips_out_of_window_loser(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True, start_sec=1.6)
    assert suppressed == []


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
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True)
    assert len(suppressed) == 1


def test_text_match_dry_run_does_not_mutate(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=True)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=False)
    assert len(suppressed) == 1
    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[0].suppressed is False


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
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True)
    assert suppressed == []
    assert host.words[1].suppressed is False
    assert guest.words[0].suppressed is False


def test_text_match_disabled_skips_suppression(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(bleed_text_match_enabled=False)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
    ):
        suppressed = suppress_overlap_text_matches(project, policy=pol, apply=True)
    assert suppressed == []
    report = overlap_duplicate_report(project)
    assert report["text_match_count"] == 1


def test_reconcile_applies_text_match_suppression(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_equal_rms,
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
