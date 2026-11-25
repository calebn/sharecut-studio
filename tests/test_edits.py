from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
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
from source_review_helpers import finite_primary_recording


def test_propose_filler_edits(minimal_project):
    proj = load_project(minimal_project)
    finite_primary_recording(proj, 3)
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
    defaults["tighten"]["breath_handling"]["enabled"] = False
    proposal = propose_tighten_edits(proj, defaults)
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
    finite_primary_recording(proj, 3)
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
    defaults["tighten"]["breath_handling"]["enabled"] = False
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


def _propose_with_performance(performance: dict) -> list[tuple[str, float, float, str]]:
    from podcast_mcp.edits.filler_pacing import FillerPacingResult

    defaults = {
        **load_defaults(),
        "tighten": {
            **load_defaults()["tighten"],
            "filler_words": ["um", "uh"],
            "breath_handling": {"enabled": False},
            "max_pause_sec": 1.0,
            "min_filler_cluster": 2,
            "inaudible_opt": False,
            "join_continuity_gate": False,
            "filler_room_tone_replace": False,
            "speech_energy_guard": {"enabled": False},
        },
    }

    def deterministic_optimize(project, track_id, start, end, **kwargs):
        from podcast_mcp.edits.cut_quality import CutRisk
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

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

    project = _two_track_filler_project()
    run_defaults = {
        **defaults,
        "performance": performance,
    }
    with (
        patch(
            "podcast_mcp.edits.tighten.prepare.optimize_and_assess",
            side_effect=deterministic_optimize,
        ),
        patch("podcast_mcp.edits.tighten.prepare.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.tighten.prepare.recommend_cut_fade_ms", return_value=20),
        patch(
            "podcast_mcp.edits.tighten.prepare.apply_filler_pacing",
            side_effect=lambda _project, _track_id, start, end, **_kwargs: FillerPacingResult(
                start=start, end=end
            ),
        ),
    ):
        propose_tighten_edits(project, run_defaults)
    return [(e.track_id, e.start, e.end, e.reason) for e in project.edit_decisions]


def test_propose_tighten_edits_parallel_matches_serial_and_preserves_order():
    def run(max_workers: int) -> list[tuple[str, float, float, str]]:
        return _propose_with_performance({"max_workers": max_workers})

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


@pytest.mark.parametrize(
    ("performance", "expected", "pools"),
    [
        ({"max_workers": None}, [1, 1], []),
        ({"max_workers": 0}, [1, 1], []),
        ({}, [1, 1], []),
        ({"max_workers": 3}, [3, 3], [2, 3]),
    ],
)
def test_propose_tighten_edits_pool_size_follows_max_workers(performance, expected, pools):
    from concurrent.futures import ThreadPoolExecutor

    from podcast_mcp.util.parallel import run_parallel

    seen: list[int | None] = []
    built: list[int | None] = []

    def recording(*args, **kwargs):
        seen.append(kwargs.get("max_workers"))
        return run_parallel(*args, **kwargs)

    def recording_pool(*args, **kwargs):
        built.append(kwargs.get("max_workers"))
        return ThreadPoolExecutor(*args, **kwargs)

    with (
        patch("podcast_mcp.edits.tighten.propose.run_parallel", side_effect=recording),
        patch("podcast_mcp.edits.tighten.prepare.run_parallel", side_effect=recording),
        patch("podcast_mcp.util.parallel.ThreadPoolExecutor", side_effect=recording_pool),
    ):
        _propose_with_performance(performance)
    assert seen == expected
    assert built == pools


@pytest.mark.parametrize(
    ("performance", "expected"),
    [
        ({}, [1, 0]),
        ({"max_workers": 0}, [1, 0]),
        ({"max_workers": 1}, [1, 1]),
        ({"max_workers": 3}, [3, 3]),
    ],
)
def test_propose_tighten_edits_uses_threads_by_default_with_enrolled_profiles(
    performance, expected
):
    from podcast_mcp.edits.tighten import candidate as cand
    from podcast_mcp.util.parallel import run_parallel

    seen: list[int | None] = []

    def recording(*args, **kwargs):
        seen.append(kwargs.get("max_workers"))
        return run_parallel(*args, **kwargs)

    enrolled = cand._SpeakerCutContext(None, {"host": object()}, loaded=False)
    with (
        patch("podcast_mcp.edits.tighten.propose._speaker_cut_context", return_value=enrolled),
        patch("podcast_mcp.edits.tighten.propose.run_parallel", side_effect=recording),
        patch("podcast_mcp.edits.tighten.prepare.run_parallel", side_effect=recording),
    ):
        _propose_with_performance(performance)
    assert seen == expected


def test_propose_tighten_embeds_each_cut_window_once_with_enrolled_profiles():
    import collections
    from types import SimpleNamespace

    import numpy as np

    from podcast_mcp.engines import speaker_id as sid

    class _Backend:
        def embed(self, samples, sample_rate):
            return np.ones(4, dtype=np.float32)

        def name(self):
            return "stub"

    seen: collections.Counter[tuple[str, float, float]] = collections.Counter()
    real = sid.score_window

    def spy(project, track_id, start, end, *args, **kwargs):
        seen[(track_id, start, end)] += 1
        return real(project, track_id, start, end, *args, **kwargs)

    def profiles(project):
        return {
            t.track_id: sid.SpeakerProfile(
                speaker_id=t.track_id,
                track_id=t.track_id,
                embedding=[1.0] * 4,
                enrollment_sec=30.0,
                stem_hash="x",
            )
            for t in project.transcripts
        }

    with (
        patch.object(sid, "load_all_profiles", side_effect=profiles),
        patch.object(sid, "resolve_speaker_backend", return_value=_Backend()),
        patch.object(sid, "score_window", side_effect=spy),
        patch(
            "podcast_mcp.project.transcript_context.load_transcript_context",
            return_value=SimpleNamespace(speaker_id=sid.SpeakerIdConfig()),
        ),
    ):
        _propose_with_performance({"max_workers": 1})
    assert seen
    assert max(seen.values()) == 1
