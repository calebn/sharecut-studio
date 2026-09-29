from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from podcast_mcp.edits.audio_quality import bleed_words, suppress_bleed_words
from podcast_mcp.edits.transcript_cuts import search_transcript
from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report, run_reconciliation
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
                TranscriptWord(
                    text="bleed",
                    start=1.0,
                    end=1.5,
                    confidence=0.9,
                    audibility_status="bleed",
                    dominant_track="guest",
                ),
                TranscriptWord(
                    text="quiet",
                    start=2.0,
                    end=2.5,
                    confidence=0.9,
                    audibility_status="inaudible",
                ),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9),
            ],
        ),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    return project


def _fake_rms(project, track_id, t_start, t_end, **kwargs):
    if track_id == "host" and t_start >= 1.0 and t_start < 1.6:
        return -40.0
    if track_id == "guest" and t_start >= 1.0 and t_start < 1.6:
        return -30.0
    if track_id == "host" and t_start >= 2.0 and t_start < 2.6:
        return -55.0
    if track_id == "guest" and t_start >= 2.0 and t_start < 2.6:
        return -60.0
    return -30.0


def test_suppress_bleed_does_not_touch_inaudible(tmp_path: Path):
    project = _two_track_project(tmp_path)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        result = suppress_bleed_words(project, dry_run=False, track_id="host")

    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is True
    assert host.words[1].audibility_status == "bleed"
    # Heuristic pick (no word_keys), not a caller decision: it recomputes
    # reconcile's own bleed verdict, so it must not lock (#781 operator decision).
    assert host.words[1].audibility_locked is False
    assert host.words[2].suppressed is False
    assert result["suppressed_count"] == 1


def test_suppress_bleed_explicit_word_keys_locks(tmp_path: Path):
    """An explicit word_keys list is a caller decision, so it locks (#768/#781)."""
    project = _two_track_project(tmp_path)
    result = suppress_bleed_words(
        project,
        dry_run=False,
        word_keys=[{"track_id": "host", "word_index": 1}],
    )
    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is True
    assert host.words[1].audibility_locked is True
    assert result["suppressed_count"] == 1


def test_suppress_bleed_heuristic_respects_existing_lock(tmp_path: Path):
    """#781: a heuristic (no word_keys) apply must not override a word a person
    or agent already locked unsuppressed."""
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words[1] = host.words[1].model_copy(
        update={"suppressed": False, "audibility_locked": True}
    )
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        result = suppress_bleed_words(project, dry_run=False, track_id="host")

    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is False
    assert host.words[1].audibility_locked is True
    assert result["suppressed_count"] == 0
    # preview == apply (#791's rule): apply skipped it, so it must not be listed
    # as a candidate either.
    assert result["candidates"] == []


def test_suppress_bleed_heuristic_dry_run_excludes_locked_unsuppressed(tmp_path: Path):
    """#781/#802: the heuristic dry-run preview must not list a word apply will
    leave alone, or it overstates what apply does."""
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words[1] = host.words[1].model_copy(
        update={"suppressed": False, "audibility_locked": True}
    )
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        result = suppress_bleed_words(project, dry_run=True, track_id="host")

    assert result["dry_run"] is True
    assert result["candidate_count"] == 0
    assert result["candidates"] == []


def test_suppress_bleed_time_range(tmp_path: Path):
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words.append(
        TranscriptWord(
            text="later",
            start=5.0,
            end=5.5,
            confidence=0.9,
            audibility_status="bleed",
            dominant_track="guest",
        )
    )

    def rms(project, track_id, t_start, t_end, **kwargs):
        if t_start >= 5.0:
            if track_id == "host":
                return -40.0
            return -30.0
        return _fake_rms(project, track_id, t_start, t_end, **kwargs)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=rms,
    ):
        dry = suppress_bleed_words(
            project, dry_run=True, track_id="host", start_sec=4.0, end_sec=6.0
        )

    assert dry["candidate_count"] == 1
    assert dry["candidates"][0]["text"] == "later"


def test_suppress_bleed_exclude_word_keys(tmp_path: Path):
    project = _two_track_project(tmp_path)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        result = suppress_bleed_words(
            project,
            dry_run=False,
            track_id="host",
            exclude_word_keys=[{"track_id": "host", "word_index": 1}],
        )

    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is False
    assert result["suppressed_count"] == 0


def test_suppress_bleed_rebuilds_combined(tmp_path: Path):
    project = _two_track_project(tmp_path)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        suppress_bleed_words(project, dry_run=False, track_id="host")

    host_text = " ".join(
        u.text for u in project.combined_transcript.utterances if u.track_id == "host"
    )
    assert "bleed" not in host_text
    matches = search_transcript(project, "bleed", track_id="host")
    assert len(matches) == 0
    guest_matches = search_transcript(project, "bleed", track_id="guest")
    assert len(guest_matches) >= 1


def test_reconcile_transcript_time_range_limits_apply(tmp_path: Path):
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words[2] = host.words[2].model_copy(update={"audibility_status": "inaudible"})

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        result = run_reconciliation(
            project,
            dry_run=False,
            track_id="host",
            start_sec=1.5,
            end_sec=3.0,
        )

    assert host.words[1].suppressed is False
    assert host.words[2].suppressed is True
    assert len(result["suppress"]) == 1


def test_overlap_duplicate_report_text_match(tmp_path: Path):
    project = _two_track_project(tmp_path)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        report = overlap_duplicate_report(project, start_sec=0.5, end_sec=2.0)

    assert report["pair_count"] >= 1
    assert report["text_match_count"] >= 1
    match = next(p for p in report["pairs"] if p["text_match"])
    assert match["text_a"] == "bleed"
    assert match["text_b"] == "bleed"


def test_bleed_words_filters_status(tmp_path: Path):
    project = _two_track_project(tmp_path)
    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_fake_rms,
    ):
        rows = bleed_words(project, track_id="host")

    assert len(rows) == 1
    assert rows[0]["audibility_status"] == "bleed"
