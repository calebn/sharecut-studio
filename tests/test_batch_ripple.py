from __future__ import annotations

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.timeline_ops import batch_ripple_delete, ripple_delete
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _two_track_project() -> EpisodeProject:
    p = EpisodeProject.create("batch", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=30.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=30.0),
        ),
    ]
    for tid in ("host", "guest"):
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=30.0,
                timeline_start=0.0,
            )
        )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5),
                TranscriptWord(text="um", start=2.0, end=2.2),
                TranscriptWord(text="world", start=5.0, end=5.5),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="hi", start=0.0, end=0.4),
                TranscriptWord(text="there", start=5.0, end=5.4),
            ],
        ),
    ]
    return p


def _clip_ends(project: EpisodeProject) -> dict[str, float]:
    return {
        tid: max(c.timeline_end for c in clips_for_track(project, tid)) for tid in ("host", "guest")
    }


def _word_snapshot(project: EpisodeProject) -> dict[str, list[tuple[float, float, str]]]:
    return {tr.track_id: [(w.start, w.end, w.text) for w in tr.words] for tr in project.transcripts}


def test_batch_ripple_matches_sequential_ripple():
    ranges = [(2.0, 2.5), (8.0, 9.0)]
    sequential = _two_track_project()
    for start, end in reversed(sorted(ranges)):
        ripple_delete(sequential, start, end, use_inaudible_opt=False)

    batched = _two_track_project()
    batch_ripple_delete(batched, ranges, use_inaudible_opt=False)

    assert _clip_ends(sequential) == _clip_ends(batched)
    assert _word_snapshot(sequential) == _word_snapshot(batched)


def test_batch_ripple_with_inaudible_opt_true(tmp_path):
    from unittest.mock import patch

    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    project = _two_track_project()
    with patch("podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range") as opt:
        opt.return_value = OptimizedCutRange(
            start=2.0,
            end=2.5,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.8,
            details={},
        )
        batch_ripple_delete(project, [(2.0, 2.5)], use_inaudible_opt=True)
    assert opt.called


def test_propose_fillers_runs_waveform_optimizer(monkeypatch):
    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    calls = {"n": 0}

    def fake_optimize(*args, **kwargs):
        calls["n"] += 1
        start = args[2] if len(args) > 2 else kwargs.get("start", 0.0)
        end = args[3] if len(args) > 3 else kwargs.get("end", 1.0)
        return (
            OptimizedCutRange(
                start=start,
                end=end,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.9,
                details={},
            ),
            CutRisk(score=0.1, reasons=[]),
        )

    monkeypatch.setattr("podcast_mcp.edits.fillers.optimize_and_assess", fake_optimize)
    monkeypatch.setattr("podcast_mcp.edits.fillers.detect_adjacent_breath", lambda *a, **k: [])
    project = _two_track_project()
    project.transcripts[0].words.extend(
        [
            TranscriptWord(text="like", start=10.0, end=10.2),
            TranscriptWord(text="uh", start=10.25, end=10.45),
        ]
    )
    defaults = {
        "tighten": {
            "filler_words": ["um", "like", "uh"],
            "max_pause_sec": 99.0,
            "crossfade_ms": 10,
            "min_filler_cluster": 2,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert calls["n"] >= 1
    assert any((e.reason or "").startswith("filler:") for e in project.edit_decisions)
