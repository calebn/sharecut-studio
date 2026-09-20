from __future__ import annotations

import random
import time
from unittest.mock import patch

from podcast_mcp.config import load_defaults
from podcast_mcp.edits import propose_tighten_edits
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)


def test_propose_filler_edits(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Hello", start=0.0, end=0.3),
                TranscriptWord(text="um", start=0.35, end=0.5),
                TranscriptWord(text="uh", start=0.55, end=0.7),
                TranscriptWord(text="world", start=2.0, end=2.3),
            ],
        )
    )
    proposal = propose_tighten_edits(proj, load_defaults())
    reasons = {e.reason for e in proposal.decisions}
    assert any(r and r.startswith("filler:") for r in reasons)
    assert [e.id for e in proposal.decisions] == [e.id for e in proj.edit_decisions]


def test_propose_tighten_keeps_existing_when_not_replacing(minimal_project):
    from podcast_mcp.models import EditDecision, EditDecisionType

    proj = load_project(minimal_project)
    existing = EditDecision(
        id="keep-me",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=0.1,
        end=0.2,
        reason="filler:um",
        review_required=False,
    )
    proj.edit_decisions = [existing]
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
                TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
                TranscriptWord(text="said", start=0.45, end=0.7, confidence=0.95),
                TranscriptWord(text="like", start=1.0, end=1.2, confidence=0.95),
                TranscriptWord(text="world", start=1.3, end=1.5, confidence=0.95),
            ],
        )
    )
    defaults = load_defaults()
    defaults["tighten"]["max_pause_sec"] = 99.0
    proposal = propose_tighten_edits(proj, defaults, replace_existing=False)
    assert any(e.id == "keep-me" for e in proj.edit_decisions)
    assert "discourse kept" in proposal.summary()


def test_propose_tighten_decisions_match_project_after_coalesce(minimal_project):
    proj = load_project(minimal_project)
    proj.transcripts.append(
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Hello", start=0.0, end=0.3),
                TranscriptWord(text="um", start=0.35, end=0.5),
                TranscriptWord(text="uh", start=0.55, end=0.7),
                TranscriptWord(text="world", start=2.0, end=2.3),
            ],
        )
    )
    defaults = load_defaults()
    defaults["tighten"]["inaudible_opt"] = False
    proposal = propose_tighten_edits(proj, defaults)
    assert proposal.decisions
    assert [e.id for e in proposal.decisions] == [e.id for e in proj.edit_decisions]


def _two_track_filler_project() -> EpisodeProject:
    project = EpisodeProject.create("multi", "/tmp/ws")
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"/tmp/ws/raw/{tid}.wav", duration_sec=60.0),
        )
        for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(id=f"c_{tid}", track_id=tid, source_start=0.0, source_end=60.0, timeline_start=0.0)
        for tid in ("host", "guest")
    ]
    project.transcripts = [
        Transcript(
            track_id=tid,
            words=[
                TranscriptWord(text="so", start=0.0, end=0.2),
                TranscriptWord(text="um", start=0.3, end=0.5),
                TranscriptWord(text="uh", start=0.6, end=0.8),
                TranscriptWord(text="anyway", start=2.0, end=2.4),
                TranscriptWord(text="really", start=2.5, end=2.8),
                TranscriptWord(text="um", start=2.9, end=3.1),
                TranscriptWord(text="uh", start=3.2, end=3.4),
                TranscriptWord(text="done", start=5.0, end=5.3),
            ],
        )
        for tid in ("host", "guest")
    ]
    return project


def test_propose_tighten_edits_parallel_matches_serial_and_preserves_order():
    """Real ThreadPoolExecutor (max_workers > 1) across two tracks must produce the
    same decisions, in the same order, as a fully serial run -- gather-in-parallel,
    apply-in-original-order must be order-independent of thread completion timing.
    """
    from podcast_mcp.edits.filler_pacing import FillerPacingResult

    defaults = {
        **load_defaults(),
        "tighten": {
            **load_defaults()["tighten"],
            "filler_words": ["um", "uh"],
            "max_pause_sec": 1.0,
            "min_filler_cluster": 2,
            "inaudible_opt": False,
            "join_continuity_gate": False,
            "filler_room_tone_replace": False,
            "speech_energy_guard": {"enabled": False},
        },
    }

    def jittery_optimize(project, track_id, start, end, **kwargs):
        from podcast_mcp.edits.cut_quality import CutRisk
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        time.sleep(random.uniform(0.0, 0.01))
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

    def run(max_workers: int) -> list[tuple[str, float, float, str]]:
        project = _two_track_filler_project()
        run_defaults = {
            **defaults,
            "performance": {"max_workers": max_workers},
        }
        with (
            patch(
                "podcast_mcp.edits.fillers.optimize_and_assess",
                side_effect=jittery_optimize,
            ),
            patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
            patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
            patch(
                "podcast_mcp.edits.fillers.apply_filler_pacing",
                side_effect=lambda _project, _track_id, start, end, **_kwargs: FillerPacingResult(
                    start=start, end=end, replace_gap_sec=None
                ),
            ),
        ):
            propose_tighten_edits(project, run_defaults)
        return [(e.track_id, e.start, e.end, e.reason) for e in project.edit_decisions]

    serial = run(max_workers=1)
    parallel = run(max_workers=4)
    assert serial == parallel
    assert len(serial) > 0
    # coalesce_edits groups each track's decisions into one contiguous run (order
    # of tracks themselves isn't guaranteed, but decisions from the same track
    # must not be interleaved with another track's) -- verify no track reappears
    # after a different track's block has started.
    track_order = [t for t, _, _, _ in serial]
    seen_tracks: list[str] = []
    for t in track_order:
        if not seen_tracks or seen_tracks[-1] != t:
            seen_tracks.append(t)
    assert len(seen_tracks) == len(set(track_order))
