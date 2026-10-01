from __future__ import annotations

import copy
import wave

import pytest

from podcast_mcp.edits.transcript_timing import TranscriptTimingChangedError, WordTimingTarget
from podcast_mcp.engines.play_audit import track_render_hash
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, Transcript, TranscriptWord
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService


def workspace(path):
    ws = ProjectWorkspace.open(path)
    for name in ("primary", "extra"):
        with wave.open(str(ws.project.raw_dir() / f"{name}.wav"), "wb") as audio:
            audio.setparams((1, 2, 1000, 0, "NONE", "not compressed"))
            audio.writeframes(bytes(20000))
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role="dialogue",
            media=MediaAsset(path="raw/primary.wav", duration_sec=10, sample_rate=1000),
        )
    ]
    ws.project.sources = [
        SourceRecording(id="extra", path="raw/extra.wav", duration_sec=10, sample_rate=1000),
        SourceRecording(id="alias", path="raw/primary.wav", duration_sec=10, sample_rate=1000),
    ]
    ws.project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="same", start=1, end=2)]),
        Transcript(
            track_id="host",
            source_id="extra",
            words=[
                TranscriptWord(text="before", start=0, end=1),
                TranscriptWord(
                    text="same",
                    start=1,
                    end=2,
                    ignored=True,
                    audibility_locked=True,
                    alignment_score=0.3,
                    suspect_hallucination=True,
                ),
                TranscriptWord(text="after", start=2, end=3),
            ],
        ),
    ]
    ws.project.clips = [
        Clip(
            id="primary",
            track_id="host",
            source_id="alias",
            source_start=0,
            source_end=5,
            timeline_start=30,
        ),
        Clip(
            id="extra",
            track_id="host",
            source_id="extra",
            source_start=0,
            source_end=5,
            timeline_start=40,
        ),
    ]
    ws.save()
    return ws


def context(svc, target):
    return svc.word_timing_context(target, expected_text="same", expected_start=1, expected_end=2)


def test_exact_source_preserves_primary_and_choices_and_one_undo(minimal_project):
    ws = workspace(minimal_project)
    before = copy.deepcopy(ws.project.transcripts)
    old_hash = track_render_hash(ws.project, "host")
    svc = EditService(ws)
    target = WordTimingTarget("host", "extra", 1)
    shown = context(svc, target)
    assert shown["media"]["ref"] == "source:extra"
    assert shown["media"]["duration_sec"] == 10
    result = svc.set_word_timing(target, shown["expected_token"], 1.25, 2.25)
    assert result["changed"]
    assert ws.project.transcripts[0] == before[0]
    changed = ws.project.transcripts[1]
    assert (changed.words[1].start, changed.words[1].end) == (1.25, 2.25)
    assert changed.words[1].ignored and changed.words[1].audibility_locked
    assert changed.words[1].alignment_score is None
    assert not changed.words[1].suspect_hallucination
    assert changed.user_edited
    assert "overlaps the next" in result["context"]["warnings"][0]
    assert track_render_hash(ws.project, "host") != old_hash
    HistoryService(ws).undo(rerender=False)
    assert ws.project.transcripts == before
    assert track_render_hash(ws.project, "host") == old_hash
    HistoryService(ws).redo(rerender=False)
    assert ws.project.transcripts[1].words[1].start == 1.25


def test_primary_alias_and_unplaced_source_use_raw_clock(minimal_project):
    ws = workspace(minimal_project)
    svc = EditService(ws)
    primary = WordTimingTarget("host", None, 0)
    shown = context(svc, primary)
    assert shown["media"]["ref"] == "track:host"
    assert shown["word"]["start"] == 1
    ws.project.clips = []
    ws.save()
    result = svc.set_word_timing(primary, shown["expected_token"], 0.9, 2)
    assert result["changed"]
    assert ws.project.transcripts[0].words[0].start == 0.9
    assert ws.project.transcripts[1].words[1].start == 1


def test_noop_creates_no_history(minimal_project):
    ws = workspace(minimal_project)
    svc = EditService(ws)
    target = WordTimingTarget("host", "extra", 1)
    shown = context(svc, target)
    history = ws.project.history.model_dump()
    assert not svc.set_word_timing(target, shown["expected_token"], 1, 2)["changed"]
    assert ws.project.history.model_dump() == history
    assert not ws.project.transcripts[1].user_edited


@pytest.mark.parametrize("change", ["identical_insert", "timing", "flag", "neighbor", "media"])
def test_stale_dependencies_reject_without_history(minimal_project, change):
    ws = workspace(minimal_project)
    target = WordTimingTarget("host", "extra", 1)
    svc = EditService(ws)
    shown = context(svc, target)
    other = ProjectWorkspace.open(minimal_project)
    tr = other.project.transcripts[1]
    if change == "identical_insert":
        tr.words.insert(1, tr.words[1].model_copy())
    elif change == "timing":
        tr.words[1].start = 1.1
    elif change == "flag":
        tr.words[1].ignored = False
    elif change == "neighbor":
        tr.words[0].end = 1.2
    else:
        other.project.sources[0].duration_sec = 9
    other.save()
    history = other.project.history.model_dump()
    with pytest.raises(TranscriptTimingChangedError):
        svc.set_word_timing(target, shown["expected_token"], 1.1, 2.2)
    assert ws.project.history.model_dump() == history


@pytest.mark.parametrize(
    "start,end", [(float("nan"), 2), (1, float("inf")), (-1, 2), (1, 11), (2, 1), (1, 1.0001)]
)
def test_reject_invalid_media_bounds(minimal_project, start, end):
    ws = workspace(minimal_project)
    svc = EditService(ws)
    target = WordTimingTarget("host", "extra", 1)
    shown = context(svc, target)
    with pytest.raises(ValueError):
        svc.set_word_timing(target, shown["expected_token"], start, end)
    assert not ws.project.transcripts[1].user_edited


def test_zero_span_repair_and_unknown_duration(minimal_project):
    ws = workspace(minimal_project)
    ws.project.transcripts[0].words[0].end = 1
    ws.save()
    svc = EditService(ws)
    target = WordTimingTarget("host", None, 0)
    shown = svc.word_timing_context(target, expected_text="same", expected_start=1, expected_end=1)
    svc.set_word_timing(target, shown["expected_token"], 1, 1.001)
    assert ws.project.transcripts[0].words[0].end == 1.001
    ws.project.sources[0].duration_sec = None
    ws.save()
    extra = WordTimingTarget("host", "extra", 1)
    shown = context(svc, extra)
    assert shown["media"]["duration_sec"] is None
    with pytest.raises(ValueError, match="duration is unavailable"):
        svc.set_word_timing(extra, shown["expected_token"], 1.1, 2.1)


def test_context_rejects_stale_chip_and_exact_missing_key(minimal_project):
    ws = workspace(minimal_project)
    svc = EditService(ws)
    with pytest.raises(TranscriptTimingChangedError):
        svc.word_timing_context(
            WordTimingTarget("host", None, 0), expected_text="new", expected_start=1, expected_end=2
        )
    with pytest.raises(TranscriptTimingChangedError):
        context(svc, WordTimingTarget("host", "alias", 0))


@pytest.mark.parametrize("locked,ignored", [(False, False), (True, False), (False, True)])
def test_retiming_invalidates_automatic_verdict_but_preserves_choices(
    minimal_project, locked, ignored
):
    from podcast_mcp.edits.transcript_sync import rebuild_combined

    ws = workspace(minimal_project)
    transcript = ws.project.transcripts[0]
    transcript.silence_filter_fingerprint = "old-evidence"
    word = transcript.words[0]
    word.suppressed = True
    word.audibility_locked = locked
    word.ignored = ignored
    word.audibility_status = "foreign_only"
    word.dominant_track = "guest"
    word.speaker_match_track = "guest"
    word.speaker_match_score = 0.8
    rebuild_combined(ws.project)
    ws.save()
    before = copy.deepcopy(ws.project.transcripts)
    target = WordTimingTarget("host", None, 0)
    svc = EditService(ws)
    svc.set_word_timing(target, context(svc, target)["expected_token"], 1.2, 2.2)
    changed = ws.project.transcripts[0]
    assert changed.silence_filter_fingerprint is None
    assert changed.words[0].suppressed is (locked or ignored)
    assert changed.words[0].audibility_status == ("foreign_only" if locked or ignored else None)
    assert changed.words[0].dominant_track == ("guest" if locked or ignored else None)
    assert changed.words[0].speaker_match_score == (0.8 if locked or ignored else None)
    if not locked and not ignored:
        assert any(
            u.track_id == "host" and "same" in u.text
            for u in ws.project.combined_transcript.utterances
        )
    HistoryService(ws).undo(rerender=False)
    assert ws.project.transcripts == before


def test_duration_uses_current_recording_waveform_metadata(minimal_project):
    from podcast_mcp.engines.waveform_media import MediaEntry, pyramid_target
    from podcast_mcp.engines.waveform_pyramid import write_synthetic_pyramid

    ws = workspace(minimal_project)
    ws.project.sources[0].duration_sec = None
    ws.project.sources[0].sample_rate = None
    ws.save()
    path = ws.project.raw_dir() / "extra.wav"
    pyramid = pyramid_target(
        ws.project.artifacts_dir(), "source:extra", MediaEntry("raw", path, "raw/extra.wav")
    )
    write_synthetic_pyramid(pyramid.out, sample_rate=1000, total_frames=10000, seed=1)
    svc = EditService(ws)
    target = WordTimingTarget("host", "extra", 1)
    shown = context(svc, target)
    assert shown["media"]["duration_sec"] == 10
    assert shown["media"]["sample_rate"] == 1000
    svc.set_word_timing(target, shown["expected_token"], 1.1, 2.1)


def test_replaced_or_removed_recording_rejects_without_history(minimal_project):
    import os

    ws = workspace(minimal_project)
    svc = EditService(ws)
    target = WordTimingTarget("host", "extra", 1)
    shown = context(svc, target)
    path = ws.project.raw_dir() / "extra.wav"
    original = path.stat()
    replacement = path.with_suffix(".new")
    replacement.write_bytes(path.read_bytes())
    os.utime(replacement, ns=(original.st_atime_ns, original.st_mtime_ns))
    replacement.replace(path)
    history = ws.project.history.model_dump()
    with pytest.raises(TranscriptTimingChangedError):
        svc.set_word_timing(target, shown["expected_token"], 1.1, 2.1)
    assert ws.project.history.model_dump() == history
    shown = context(svc, target)
    path.unlink()
    with pytest.raises(TranscriptTimingChangedError, match="unavailable"):
        svc.set_word_timing(target, shown["expected_token"], 1.1, 2.1)
    assert ws.project.history.model_dump() == history


def test_bad_waveform_metadata_falls_back_to_stored_duration(minimal_project):
    from podcast_mcp.engines.waveform_media import MediaEntry, pyramid_target

    ws = workspace(minimal_project)
    path = ws.project.raw_dir() / "extra.wav"
    pyramid = pyramid_target(
        ws.project.artifacts_dir(), "source:extra", MediaEntry("raw", path, "raw/extra.wav")
    )
    pyramid.out.parent.mkdir(parents=True, exist_ok=True)
    pyramid.out.write_bytes(b"incomplete-waveform")
    shown = context(EditService(ws), WordTimingTarget("host", "extra", 1))
    assert shown["media"]["duration_sec"] == 10
    assert shown["media"]["sample_rate"] == 1000


def test_invalid_stored_metadata_disables_bounds_and_previous_overlap_warns(minimal_project):
    ws = workspace(minimal_project)
    ws.project.sources[0].duration_sec = 0
    ws.project.sources[0].sample_rate = 0
    ws.project.transcripts[1].words[0].end = 1.5
    ws.save()
    shown = context(EditService(ws), WordTimingTarget("host", "extra", 1))
    assert shown["media"]["duration_sec"] is None
    assert shown["media"]["sample_rate"] is None
    assert "overlaps the previous" in shown["warnings"][0]
