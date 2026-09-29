"""Tier A fixtures for voiced speech cut through at a splice (#775)."""

from __future__ import annotations

import re
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.clips_ops import clips_for_track, is_splice, splice_joins
from podcast_mcp.edits.join_speech import (
    JoinSpeechConfig,
    find_speech_crossings,
    speech_crossing_at_edge,
    speech_crossings_in_window,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

RATE = 16_000


def _voice(total_sec: float, start: float, end: float, *, f0: float = 150.0) -> np.ndarray:
    """A vowel-like harmonic complex: periodic at ``f0`` like voiced speech."""
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    n = int((end - start) * RATE)
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 7))
    samples[int(start * RATE) : int(start * RATE) + n] = (0.25 * tone / 2.45).astype(np.float32)
    return samples


def _breath(total_sec: float, start: float, end: float) -> np.ndarray:
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    n = int((end - start) * RATE)
    noise = np.random.default_rng(7).normal(0, 0.08, n)
    samples[int(start * RATE) : int(start * RATE) + n] = noise.astype(np.float32)
    return samples


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())


def _project(
    tmp_path: Path,
    samples: np.ndarray,
    clips: list[tuple[float, float]],
    words: list[TranscriptWord] | None = None,
) -> EpisodeProject:
    """One dialogue track whose clips abut on the timeline in the given source ranges."""
    project = EpisodeProject.create("join-speech", str(tmp_path))
    _write_wav(tmp_path / "raw" / "host.wav", samples)
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=samples.size / RATE),
        )
    )
    t = 0.0
    for i, (start, end) in enumerate(clips):
        project.timeline.clips.append(
            Clip(
                id=f"c{i}",
                track_id="host",
                source_start=start,
                source_end=end,
                timeline_start=t,
            )
        )
        t += end - start
    project.transcripts = [Transcript(track_id="host", words=words or [])]
    return project


def test_clipped_onset_reports_voice_edge_and_late_asr_word(tmp_path: Path) -> None:
    """The right clip resumes 340 ms into a vowel that started at 1.0 s; Whisper put the
    word 490 ms after the voice onset (the lab's Lana join, in miniature)."""
    audio = _voice(3.0, 1.0, 2.2)
    project = _project(
        tmp_path,
        audio,
        [(0.0, 0.5), (1.34, 3.0)],
        [
            TranscriptWord(text="Um,", start=1.49, end=1.9),
            TranscriptWord(text="what", start=2.0, end=2.2),
        ],
    )
    hits = find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host")))
    assert len(hits) == 1
    hit = hits[0].to_dict()
    assert hit["direction"] == "clipped_onset"
    assert hit["clip_id"] == "c1"
    assert hit["join_timeline_sec"] == 0.5
    assert hit["cut_source_sec"] == 1.34
    assert hit["voice_edge_source_sec"] == pytest.approx(1.0, abs=0.02)
    assert hit["removed_ms"] == pytest.approx(340.0, abs=20.0)
    assert hit["suggested_source_sec"] == pytest.approx(0.94, abs=0.02)
    assert hit["asr_next_word"] == "Um,"
    assert hit["asr_next_start_sec"] == 1.49
    assert hit["asr_prev_word"] is None
    assert hit["asr_lag_ms"] == pytest.approx(490.0, abs=20.0)
    assert hit["asr_disagrees"] is True
    # The vowel sits near -21 dBFS on both sides of the edge: a phrase, not a remnant.
    assert hit["kept_level_db"] == pytest.approx(-21.1, abs=1.0)
    assert hit["removed_level_db"] == pytest.approx(-21.1, abs=1.0)


def test_clipped_tail_reports_voice_continuing_past_the_clip_end(tmp_path: Path) -> None:
    audio = _voice(3.0, 0.5, 1.5)
    project = _project(
        tmp_path,
        audio,
        [(0.0, 1.2), (2.0, 3.0)],
        [TranscriptWord(text="Parton.", start=0.6, end=1.18)],
    )
    hits = find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host")))
    assert [h.direction for h in hits] == ["clipped_tail"]
    hit = hits[0].to_dict()
    assert hit["clip_id"] == "c0"
    assert hit["cut_source_sec"] == 1.2
    assert hit["voice_edge_source_sec"] == pytest.approx(1.5, abs=0.02)
    assert hit["removed_ms"] == pytest.approx(300.0, abs=20.0)
    assert hit["suggested_source_sec"] == pytest.approx(1.56, abs=0.02)
    assert hit["asr_prev_word"] == "Parton."
    assert hit["asr_lag_ms"] == pytest.approx(320.0, abs=20.0)
    assert hit["asr_disagrees"] is True


def test_cut_covered_by_a_word_is_not_an_asr_disagreement(tmp_path: Path) -> None:
    audio = _voice(3.0, 1.0, 2.2)
    project = _project(
        tmp_path,
        audio,
        [(0.0, 0.5), (1.34, 3.0)],
        [TranscriptWord(text="Um,", start=1.0, end=1.5)],
    )
    (hit,) = find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host")))
    assert hit.asr_disagrees is False
    assert hit.asr_next_word is None


def test_cut_in_silence_before_the_onset_is_clean(tmp_path: Path) -> None:
    audio = _voice(3.0, 1.0, 2.2)
    project = _project(tmp_path, audio, [(0.0, 0.5), (0.9, 3.0)])
    assert (
        find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host"))) == []
    )


def test_cut_through_a_breath_is_not_flagged(tmp_path: Path) -> None:
    """Broadband breath noise before the resume point fails the voicing probe."""
    audio = _breath(3.0, 1.0, 1.6) + _voice(3.0, 1.6, 2.4)
    project = _project(tmp_path, audio, [(0.0, 0.5), (1.3, 3.0)])
    assert (
        find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host"))) == []
    )


def test_remnant_dying_inside_the_clip_is_not_a_clipped_onset(tmp_path: Path) -> None:
    """The kept side carries only 50 ms of the removed vowel: a leftover, not a phrase."""
    audio = _voice(3.0, 1.0, 1.39)
    project = _project(tmp_path, audio, [(0.0, 0.5), (1.34, 3.0)])
    assert (
        find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host"))) == []
    )


def test_split_clip_with_continuous_source_is_not_a_splice() -> None:
    left = Clip(id="a", track_id="h", source_start=0.0, source_end=1.0, timeline_start=0.0)
    right = Clip(id="b", track_id="h", source_start=1.0, source_end=2.0, timeline_start=1.0)
    assert is_splice(left, right) is False
    moved = Clip(
        id="c",
        track_id="h",
        source_start=1.0,
        source_end=2.0,
        timeline_start=1.0,
        source_id="other",
    )
    assert is_splice(left, moved) is True
    assert splice_joins([left, right, moved]) == [(right, moved)]


def test_gated_silence_holds_no_speech_to_clip() -> None:
    quiet = (np.random.default_rng(1).normal(0, 1e-4, RATE)).astype(np.float32)
    assert (
        speech_crossing_at_edge(
            quiet, RATE, edge_index=RATE // 2, side="onset", config=JoinSpeechConfig()
        )
        is None
    )


def test_window_filter_keeps_only_joins_inside_the_timeline_span(tmp_path: Path) -> None:
    audio = _voice(6.0, 1.0, 2.2) + _voice(6.0, 4.0, 5.5)
    project = _project(tmp_path, audio, [(0.0, 0.5), (1.34, 3.0), (4.4, 6.0)])
    # Joins at timeline 0.5 s and 2.16 s; both clipped onsets.
    all_hits = speech_crossings_in_window(project, ["host"], 0.0, 10.0)
    assert [round(h.join_timeline_sec, 2) for h in all_hits] == [0.5, 2.16]
    only_second = speech_crossings_in_window(project, ["host"], 2.0, 3.0)
    assert [h.clip_id for h in only_second] == ["c2"]


def test_missing_media_yields_no_crossings(tmp_path: Path) -> None:
    project = _project(tmp_path, _voice(3.0, 1.0, 2.2), [(0.0, 0.5), (1.34, 3.0)])
    project.tracks[0].media = None
    assert (
        find_speech_crossings(project, "host", splice_joins(clips_for_track(project, "host"))) == []
    )


def test_caller_samples_are_reused_instead_of_reading_media(tmp_path: Path) -> None:
    audio = _voice(3.0, 1.0, 2.2)
    project = _project(tmp_path, audio, [(0.0, 0.5), (1.34, 3.0)])
    (tmp_path / "raw" / "host.wav").unlink()
    hits = find_speech_crossings(
        project,
        "host",
        splice_joins(clips_for_track(project, "host")),
        samples=audio,
        sample_rate=RATE,
    )
    assert [h.direction for h in hits] == ["clipped_onset"]
    assert hits[0].removed_ms == pytest.approx(340.0, abs=20.0)


def test_audition_context_flags_the_clipped_onset_with_a_concrete_fix(tmp_path: Path) -> None:
    from podcast_mcp.edits.audition_context import build_audition_context

    audio = _voice(3.0, 1.0, 2.2)
    project = _project(
        tmp_path,
        audio,
        [(0.0, 0.5), (1.34, 3.0)],
        [TranscriptWord(text="Um,", start=1.49, end=1.9)],
    )
    ctx = build_audition_context(project, 0.0, 1.5, include_prosody=False)
    (hyp,) = [h for h in ctx["hypotheses"] if h["code"] == "speech_crosses_cut"]
    assert hyp["tracks"] == ["host"]
    assert hyp["severity"] == "warn"
    assert hyp["confidence"] == "measured"
    assert hyp["window"] == {"clock": "timeline", "unit": "sec", "start": 0.0, "end": 1.5}
    assert hyp["evidence"]["direction"] == "clipped_onset"
    assert hyp["evidence"]["clip_id"] == "c1"
    assert hyp["evidence"]["removed_ms"] == pytest.approx(340.0, abs=20.0)
    assert hyp["evidence"]["asr_disagrees"] is True
    assert hyp["next"]["tools"] == [
        "trim_clip_edge_tool",
        "suggest_handoff_cut_tool",
        "play_audio_tool",
    ]
    assert hyp["next"]["fix"] == {"skill": "podcast-inaudible-cuts", "autonomy": "needs_approval"}
    # One dialogue track, so its clip edge is the whole session's join.
    assert hyp["evidence"]["session_join"] is True
    assert hyp["evidence"]["fix"] == {
        "tool": "trim_clip_edge_tool",
        "clip_id": "c1",
        "edge": "in",
        "source_sec": pytest.approx(0.94, abs=0.02),
        "all_tracks": True,
    }
    warning = next(w for w in ctx["warnings"] if w.startswith("speech_crosses_cut:"))
    assert re.search(r"host: clip starts 3[45]0 ms into voiced speech \(voice from source", warning)
    assert "'Um,' starts 1.49s" in warning
    assert "word times disagree with the audio here" in warning
    assert re.search(
        r"trim the in-point back to 0\.9[34]s on every track \(trim_clip_edge_tool with "
        r"all_tracks=true; this join is a session-wide cut\), or move the cut",
        warning,
    )
    assert "cannot_hear" in ctx["limits"]


def test_track_local_edge_gets_a_single_clip_fix(tmp_path: Path) -> None:
    """A second track with no clip edge at the join makes the boundary track-local."""
    from podcast_mcp.edits.audition_context import build_audition_context

    audio = _voice(3.0, 1.0, 2.2)
    project = _project(tmp_path, audio, [(0.0, 0.5), (1.34, 3.0)])
    project.timeline.tracks.append(
        Track(
            id="peer",
            label="Peer",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=3.0),
        )
    )
    project.timeline.clips.append(
        Clip(id="p0", track_id="peer", source_start=0.0, source_end=3.0, timeline_start=0.0)
    )
    ctx = build_audition_context(project, 0.0, 1.5, include_prosody=False)
    (hyp,) = [h for h in ctx["hypotheses"] if h["code"] == "speech_crosses_cut"]
    assert hyp["evidence"]["session_join"] is False
    assert hyp["evidence"]["fix"]["all_tracks"] is False
    assert hyp["evidence"]["fix"]["clip_id"] == "c1"
    warning = next(w for w in ctx["warnings"] if w.startswith("speech_crosses_cut:"))
    assert "on clip c1 (trim_clip_edge_tool; this edge is track-local)" in warning


def test_audition_context_skips_the_join_check_without_dsp(tmp_path: Path) -> None:
    from podcast_mcp.edits.audition_context import build_audition_context

    project = _project(tmp_path, _voice(3.0, 1.0, 2.2), [(0.0, 0.5), (1.34, 3.0)])
    ctx = build_audition_context(project, 0.0, 1.5, include_dsp=False, include_prosody=False)
    assert not [h for h in ctx["hypotheses"] if h["code"] == "speech_crosses_cut"]
