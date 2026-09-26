from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.breath_detect import (
    BreathSpan,
    detect_adjacent_breath,
    extend_cut_for_breaths,
)
from podcast_mcp.edits.cut_quality import (
    CutRisk,
    assess_cut_risk,
    recommend_cut_fade_ms,
    word_margin_violation_sec,
)
from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project_with_transcript(words: list[TranscriptWord]) -> EpisodeProject:
    project = EpisodeProject.create("fillers", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=30.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    return project


def _passthrough_opt(start: float, end: float):
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    return OptimizedCutRange(
        start=start,
        end=end,
        mode="vocal_transcript_guided",
        shifted_start_ms=0.0,
        shifted_end_ms=0.0,
        confidence=0.9,
        details={},
    )


def _safe_risk():
    return CutRisk(score=0.1, reasons=[])


def test_analyze_fillers_integration(tmp_path, sample_wav):
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("fint", str(ws))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um", start=0.5, end=0.7, confidence=0.9),
                TranscriptWord(text="uh", start=0.75, end=0.95, confidence=0.85),
                TranscriptWord(text="hello", start=2.0, end=2.4, confidence=0.95),
            ],
        )
    ]
    from podcast_mcp.config import load_defaults

    decisions = analyze_fillers_and_pauses(project, project.transcripts[0], load_defaults())
    assert decisions
    assert all(d.cut_confidence is not None for d in decisions)


@pytest.fixture(autouse=True)
def _mock_cut_pipeline(request):
    if request.node.name == "test_analyze_fillers_integration":
        yield
        return
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            side_effect=lambda project, track_id, start, end, **kw: (
                _passthrough_opt(start, end),
                _safe_risk(),
            ),
        ),
        patch(
            "podcast_mcp.edits.fillers.detect_adjacent_breath",
            return_value=[],
        ),
        patch(
            "podcast_mcp.edits.fillers.recommend_cut_fade_ms",
            return_value=25,
        ),
    ):
        yield


def test_fillers_co_remove_adjacent_breath():
    words = [
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="uh", start=1.25, end=1.45),
    ]
    project = _project_with_transcript(words)
    from podcast_mcp.edits.breath_detect import BreathSpan

    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            side_effect=lambda *a, **k: (_passthrough_opt(1.0, 1.2), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.detect_adjacent_breath",
            return_value=[BreathSpan(start=0.85, end=1.0, side="before")],
        ),
    ):
        defaults = {
            "tighten": {
                "filler_words": ["um", "uh"],
                "max_pause_sec": 99.0,
                "min_filler_cluster": 2,
            }
        }
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions
    assert project.edit_decisions[0].start == pytest.approx(0.85)


def test_pause_skipped_when_retained_pause_consumes_gap():
    words = [
        TranscriptWord(text="one", start=0.0, end=0.4),
        TranscriptWord(text="two", start=1.61, end=2.0),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {
            "filler_words": [],
            "max_pause_sec": 1.2,
            "min_retained_pause_sec": 1.2,
            "min_retained_solo_pause_sec": 1.2,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions == []


def test_solo_pause_retains_higher_floor_than_turn_pause():
    """Same-speaker thinking pauses keep more air than peer-covered turn gaps."""
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    host_words = [
        TranscriptWord(text="her", start=1.0, end=1.2),
        TranscriptWord(text="We", start=3.7, end=4.0),  # 2.5s gap
    ]
    guest_words = [
        TranscriptWord(text="yeah", start=2.0, end=2.4),  # peer in the gap
    ]

    def fake_opt(*args, **kwargs):
        start, end = args[2], args[3]
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

    # Solo: only host transcript
    solo = _project_with_transcript(host_words)
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=fake_opt),
        patch(
            "podcast_mcp.edits.fillers.detect_adjacent_breath",
            return_value=[],
        ),
    ):
        analyze_fillers_and_pauses(
            solo,
            solo.transcripts[0],
            {
                "tighten": {
                    "filler_words": [],
                    "max_pause_sec": 1.2,
                    "min_retained_pause_sec": 0.18,
                    "min_retained_solo_pause_sec": 0.55,
                    "leave_in_if_risky": True,
                }
            },
        )
    assert len(solo.edit_decisions) == 1
    d = solo.edit_decisions[0]
    assert d.reason == "pause:2.50s:solo"
    # next.start - retain = 3.7 - 0.55 = 3.15
    assert d.end == pytest.approx(3.15, abs=0.02)

    # Turn: guest speaking in the gap → aggressive floor
    turn = _project_with_transcript(host_words)
    turn.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    turn.transcripts.append(Transcript(track_id="guest", words=guest_words))
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=fake_opt),
        patch(
            "podcast_mcp.edits.fillers.detect_adjacent_breath",
            return_value=[],
        ),
    ):
        analyze_fillers_and_pauses(
            turn,
            turn.transcripts[0],
            {
                "tighten": {
                    "filler_words": [],
                    "max_pause_sec": 1.2,
                    "min_retained_pause_sec": 0.18,
                    "min_retained_solo_pause_sec": 0.55,
                    "leave_in_if_risky": True,
                }
            },
        )
    assert len(turn.edit_decisions) == 1
    d2 = turn.edit_decisions[0]
    assert d2.reason == "pause:2.50s"
    assert ":solo" not in d2.reason
    # 3.7 - 0.18 = 3.52
    assert d2.end == pytest.approx(3.52, abs=0.02)


def test_solo_pause_floor_uses_timeline_mapped_retain():
    """Prior source holes must not shrink the audible solo floor below target."""
    from podcast_mcp.edits.fillers import (
        _contiguous_retain_before_word,
        _pause_trim_end_for_timeline_floor,
    )
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    # ASR gap 1.0→3.5 (2.5s). Hole 3.0→3.2 sits before the resume clip; contiguous
    # air into "We" is only 3.2→3.5 (0.3s) < 0.55 floor.
    words = [
        TranscriptWord(text="her", start=0.8, end=1.0),
        TranscriptWord(text="We", start=3.5, end=3.8),
    ]
    project = _project_with_transcript(words)
    project.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=3.2,
            source_end=10.0,
            timeline_start=3.0,
        ),
    ]
    retain_start, retain_end = _contiguous_retain_before_word(project, "host", 1.0, 3.5)
    assert retain_start == pytest.approx(3.2)
    assert retain_end == pytest.approx(3.5)
    trim = _pause_trim_end_for_timeline_floor(project, "host", 1.0, 3.5, 0.55)
    assert trim == pytest.approx(3.2)  # cut up to resume-clip head; pad supplies rest

    def fake_opt(*args, **kwargs):
        start, end = args[2], args[3]
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

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=fake_opt),
        patch(
            "podcast_mcp.edits.fillers.detect_adjacent_breath",
            return_value=[],
        ),
    ):
        analyze_fillers_and_pauses(
            project,
            project.transcripts[0],
            {
                "tighten": {
                    "filler_words": [],
                    "max_pause_sec": 1.2,
                    "min_retained_pause_sec": 0.18,
                    "min_retained_solo_pause_sec": 0.55,
                    "leave_in_if_risky": True,
                }
            },
        )
    assert len(project.edit_decisions) == 1
    d = project.edit_decisions[0]
    assert ":solo" in (d.reason or "")
    assert d.end == pytest.approx(3.2, abs=0.03)
    # Contiguous head air 0.3s → pad ~0.25s to reach 0.55 floor.
    assert d.replace_gap_sec is not None
    assert d.replace_gap_sec == pytest.approx(0.25, abs=0.05)


def test_pause_max_end_clamps_breath_extension():
    from podcast_mcp.edits.breath_detect import BreathSpan
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    words = [
        TranscriptWord(text="her", start=1.0, end=1.2),
        TranscriptWord(text="We", start=3.7, end=4.0),
    ]
    project = _project_with_transcript(words)
    cand = _CutCandidate(
        track_id="host",
        start=1.2,
        end=3.15,
        reason="pause:2.50s:solo",
        cut_kind="pause",
        max_end=3.15,
    )
    with patch(
        "podcast_mcp.edits.fillers.detect_adjacent_breath",
        return_value=[BreathSpan(start=3.15, end=3.5, side="after")],
    ):
        result = _analyze_candidate(
            project,
            cand,
            {
                "tighten": {
                    "filler_words": [],
                    "leave_in_if_risky": True,
                }
            },
        )
    assert result is not None
    assert result.end == pytest.approx(3.15)


def test_collect_candidates_without_project_uses_turn_floor():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="one", start=0.0, end=0.4),
        TranscriptWord(text="two", start=2.0, end=2.3),
    ]
    project = _project_with_transcript(words)
    cands = _collect_candidates(
        project.transcripts[0],
        {
            "tighten": {
                "filler_words": [],
                "max_pause_sec": 1.2,
                "min_retained_pause_sec": 0.2,
                "min_retained_solo_pause_sec": 0.8,
            }
        },
        project=None,
    )
    assert len(cands) == 1
    assert cands[0].end == pytest.approx(1.8)  # 2.0 - 0.2
    assert ":solo" not in cands[0].reason


def test_repetition_candidates_are_bounded_and_review_required():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="I", start=0.0, end=0.15),
        TranscriptWord(text="I", start=0.18, end=0.32),
        TranscriptWord(text="mean", start=0.36, end=0.55),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )
    assert [candidate.reason for candidate in candidates] == ["repetition:word:i"]
    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], {"tighten": {"filler_words": []}}
    )
    assert decisions[0].review_required is True


def test_phrase_restart_and_marked_partial_word_are_review_candidates():
    from podcast_mcp.edits.fillers import _collect_candidates

    phrase = [
        TranscriptWord(text="we", start=0.0, end=0.1),
        TranscriptWord(text="could", start=0.12, end=0.3),
        TranscriptWord(text="we", start=0.34, end=0.44),
        TranscriptWord(text="could", start=0.46, end=0.64),
    ]
    partial = [
        TranscriptWord(text="stor-", start=0.0, end=0.12),
        TranscriptWord(text="store", start=0.15, end=0.35),
    ]
    for words, expected in ((phrase, "restart:phrase:we could"), (partial, "restart:partial:stor")):
        project = _project_with_transcript(words)
        candidates = _collect_candidates(
            project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
        )
        assert expected in [candidate.reason for candidate in candidates]


def test_four_word_restart_is_one_longest_candidate():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text=text, start=i * 0.2, end=i * 0.2 + 0.1)
        for i, text in enumerate(
            ["we", "should", "take", "the", "we", "should", "take", "the", "train"]
        )
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )
    assert [candidate.reason for candidate in candidates] == ["restart:phrase:we should take the"]


def test_restart_examples_strip_terminal_marker_and_split_partial_word():
    from podcast_mcp.edits.fillers import _collect_candidates

    examples = [
        (
            [
                TranscriptWord(text="I", start=0.0, end=0.1),
                TranscriptWord(text="went", start=0.12, end=0.3),
                TranscriptWord(text="to", start=0.32, end=0.4),
                TranscriptWord(text="the—", start=0.42, end=0.55),
                TranscriptWord(text="I", start=0.58, end=0.68),
                TranscriptWord(text="went", start=0.7, end=0.88),
                TranscriptWord(text="to", start=0.9, end=0.98),
                TranscriptWord(text="the", start=1.0, end=1.1),
                TranscriptWord(text="store", start=1.12, end=1.3),
            ],
            "restart:phrase:i went to the",
        ),
        (
            [
                TranscriptWord(text="I", start=0.0, end=0.1),
                TranscriptWord(text="w-", start=0.12, end=0.2),
                TranscriptWord(text="I", start=0.22, end=0.32),
                TranscriptWord(text="went", start=0.34, end=0.52),
            ],
            "restart:partial:w",
        ),
    ]
    for words, expected in examples:
        project = _project_with_transcript(words)
        candidates = _collect_candidates(
            project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
        )
        assert expected in [candidate.reason for candidate in candidates]


def test_split_partial_restart_removes_repeated_prefix_and_retains_repair():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="I", start=0.0, end=0.1),
        TranscriptWord(text="w-", start=0.12, end=0.2),
        TranscriptWord(text="I", start=0.22, end=0.32),
        TranscriptWord(text="went", start=0.34, end=0.52),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )

    assert [(candidate.start, candidate.end, candidate.reason) for candidate in candidates] == [
        (0.0, 0.2, "restart:partial:w")
    ]
    retained = [word.text for word in words if word.start >= candidates[0].end]
    assert " ".join(retained) == "I went"


def test_split_partial_restart_does_not_duplicate_word_repetition():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="I", start=0.0, end=0.1),
        TranscriptWord(text="I-", start=0.12, end=0.2),
        TranscriptWord(text="I", start=0.22, end=0.32),
        TranscriptWord(text="intended", start=0.34, end=0.52),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )

    assert [(candidate.start, candidate.end, candidate.reason) for candidate in candidates] == [
        (0.0, 0.2, "restart:partial:i")
    ]


def test_multiword_filler_repeat_does_not_become_restart_candidate():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="you", start=0.0, end=0.1),
        TranscriptWord(text="know", start=0.12, end=0.25),
        TranscriptWord(text="you", start=0.27, end=0.37),
        TranscriptWord(text="know", start=0.39, end=0.52),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0],
        {"tighten": {"filler_words": ["you know"], "min_filler_cluster": 2}},
        project=project,
    )

    assert not any(candidate.cut_kind in {"repeat", "restart"} for candidate in candidates)


def test_periodic_phrase_repeat_produces_one_small_restart_proposal():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text=text, start=index * 0.12, end=index * 0.12 + 0.1)
        for index, text in enumerate(("a", "b", "a", "b", "a", "b"))
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )

    assert [(candidate.start, candidate.end, candidate.reason) for candidate in candidates] == [
        (0.0, 0.22, "restart:phrase:a b")
    ]


def test_periodic_phrase_restart_stays_bounded_after_proposal_coalescing(monkeypatch):
    from podcast_mcp.edits import tighten as tighten_module
    from podcast_mcp.edits.fillers import _AnalyzedCut

    words = [
        TranscriptWord(text=text, start=index * 0.12, end=index * 0.12 + 0.1)
        for index, text in enumerate(("a", "b", "a", "b", "a", "b"))
    ]
    project = _project_with_transcript(words)
    monkeypatch.setattr(tighten_module, "build_track_audio_caches", lambda *_args: {})

    def analyze(_project, candidate, _defaults, *, audio_cache=None):
        return _AnalyzedCut(
            track_id=candidate.track_id,
            start=candidate.start,
            end=candidate.end,
            reason=candidate.reason,
            review_required=True,
            crossfade_ms=10,
            cut_confidence=0.9,
            boundary_mode="vocal_transcript_guided",
        )

    monkeypatch.setattr(tighten_module, "_analyze_candidate", analyze)
    proposal = tighten_module.propose_tighten_edits(project, {"tighten": {"filler_words": []}})

    assert [(edit.start, edit.end, edit.reason) for edit in proposal.decisions] == [
        (0.0, 0.22, "restart:phrase:a b")
    ]


def test_semantic_correction_is_not_detected_as_restart():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="store—", start=0.0, end=0.2),
        TranscriptWord(text="no", start=0.21, end=0.3),
        TranscriptWord(text="park", start=0.31, end=0.5),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )
    assert candidates == []


def test_split_partial_restart_requires_contiguous_timing():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="I", start=0.0, end=0.1),
        TranscriptWord(text="w-", start=1.0, end=1.1),
        TranscriptWord(text="I", start=1.12, end=1.22),
        TranscriptWord(text="went", start=1.24, end=1.42),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0], {"tighten": {"filler_words": []}}, project=project
    )
    assert candidates == []


def test_reproposal_replaces_prior_generated_restarts():
    from podcast_mcp.edits.tighten import propose_tighten_edits
    from podcast_mcp.models import EditDecision

    project = _project_with_transcript([])
    project.edit_decisions = [
        EditDecision(
            id="old",
            track_id="host",
            start=0.0,
            end=0.1,
            reason="restart:phrase:old",
            review_required=True,
            applied=False,
        ),
        EditDecision(
            id="applied",
            track_id="host",
            start=0.2,
            end=0.3,
            reason="restart:word:kept",
            review_required=True,
            applied=True,
        ),
    ]
    propose_tighten_edits(project, {"tighten": {"filler_words": []}})
    assert all(decision.id != "old" for decision in project.edit_decisions)
    assert any(decision.id == "applied" for decision in project.edit_decisions)


def test_repetition_requires_local_timestamps_and_ignores_filler_words():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="very", start=0.0, end=0.1),
        TranscriptWord(text="very", start=1.0, end=1.1),
        TranscriptWord(text="um", start=1.2, end=1.3),
        TranscriptWord(text="um", start=1.35, end=1.45),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_candidates(
        project.transcripts[0],
        {"tighten": {"filler_words": ["um"], "min_filler_cluster": 2}},
        project=project,
    )
    assert not any(candidate.reason.startswith("repetition:") for candidate in candidates)


def test_retained_pause_floor_counts_a_peer_muted_in_the_mix():
    from podcast_mcp.edits.fillers import _retained_pause_floor_sec

    host_words = [
        TranscriptWord(text="her", start=1.0, end=1.2),
        TranscriptWord(text="We", start=3.7, end=4.0),
    ]
    project = _project_with_transcript(host_words)
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            muted=True,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    project.transcripts.append(
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="yeah", start=2.0, end=2.4)],
        )
    )
    floor, solo = _retained_pause_floor_sec(
        project,
        "host",
        1.2,
        3.7,
        {
            "tighten": {
                "min_retained_pause_sec": 0.18,
                "min_retained_solo_pause_sec": 0.55,
            }
        },
    )
    # The mute is a listening choice; the guest still speaks in this gap.
    assert solo is False
    assert floor == pytest.approx(0.18)


def test_solo_floor_not_below_turn_floor():
    from podcast_mcp.edits.fillers import _retained_pause_floor_sec

    project = _project_with_transcript(
        [
            TranscriptWord(text="a", start=0.0, end=0.2),
            TranscriptWord(text="b", start=2.0, end=2.2),
        ]
    )
    floor, solo = _retained_pause_floor_sec(
        project,
        "host",
        0.2,
        2.0,
        {
            "tighten": {
                "min_retained_pause_sec": 0.4,
                "min_retained_solo_pause_sec": 0.2,  # misconfigured low
            }
        },
    )
    assert solo is True
    assert floor == pytest.approx(0.4)


def test_fillers_store_cut_confidence_on_decision():
    words = [
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="uh", start=1.25, end=1.45),
    ]
    project = _project_with_transcript(words)
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def fake_opt(*args, **kwargs):
        start, end = args[2], args[3]
        return (
            OptimizedCutRange(
                start=start,
                end=end,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.77,
                details={},
            ),
            CutRisk(score=0.1, reasons=[]),
        )

    with patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=fake_opt):
        defaults = {
            "tighten": {
                "filler_words": ["um", "uh"],
                "max_pause_sec": 99.0,
                "min_filler_cluster": 2,
            }
        }
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions[0].cut_confidence == 0.77
    assert project.edit_decisions[0].boundary_mode == "vocal_transcript_guided"


def test_append_optimized_cut_returns_none_when_invalid_range():
    words = [
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="uh", start=1.25, end=1.45),
    ]
    project = _project_with_transcript(words)
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            side_effect=lambda *a, **k: (_passthrough_opt(1.0, 1.2), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.extend_cut_for_breaths",
            return_value=(1.2, 1.0),
        ),
    ):
        defaults = {
            "tighten": {
                "filler_words": ["um", "uh"],
                "max_pause_sec": 99.0,
                "min_filler_cluster": 2,
            }
        }
        decisions = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert decisions == []


def test_fillers_cut_all_when_min_cluster_is_one():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.4),
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="world", start=2.0, end=2.4),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {
            "filler_words": ["um"],
            "max_pause_sec": 99.0,
            "min_filler_cluster": 1,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert len(project.edit_decisions) == 1
    assert project.edit_decisions[0].reason == "filler:um"
    assert project.edit_decisions[0].crossfade_ms == 25


def test_fillers_skip_isolated_when_min_cluster_is_two():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.4),
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="world", start=2.0, end=2.4),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {
            "filler_words": ["um"],
            "max_pause_sec": 99.0,
            "min_filler_cluster": 2,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions == []


def test_fillers_cut_clustered_fillers():
    words = [
        TranscriptWord(text="so", start=0.0, end=0.2),
        TranscriptWord(text="um", start=0.3, end=0.5),
        TranscriptWord(text="uh", start=0.6, end=0.8),
        TranscriptWord(text="yeah", start=1.5, end=1.8),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {
            "filler_words": ["um", "uh"],
            "max_pause_sec": 99.0,
            "min_filler_cluster": 2,
            "filler_cluster_gap_sec": 1.0,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    reasons = {e.reason for e in project.edit_decisions}
    assert reasons == {"filler:um", "filler:uh"}


def test_fillers_leave_in_when_risky():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.4),
        TranscriptWord(text="um", start=1.0, end=1.2, confidence=0.05),
        TranscriptWord(text="world", start=2.0, end=2.4),
    ]
    project = _project_with_transcript(words)
    risky = CutRisk(score=1.0, reasons=["harsh join"])
    with patch(
        "podcast_mcp.edits.fillers.optimize_and_assess",
        side_effect=lambda *a, **k: (_passthrough_opt(1.0, 1.2), risky),
    ):
        defaults = {
            "tighten": {
                "filler_words": ["um"],
                "max_pause_sec": 99.0,
                "min_filler_cluster": 1,
                "leave_in_if_risky": True,
            }
        }
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions == []


def test_pause_cut_retains_minimum_gap():
    words = [
        TranscriptWord(text="one", start=0.0, end=0.4),
        TranscriptWord(text="two", start=2.0, end=2.4),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {
            "filler_words": [],
            "max_pause_sec": 1.0,
            "min_retained_pause_sec": 0.2,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert len(project.edit_decisions) == 1
    pause = project.edit_decisions[0]
    assert pause.end <= 2.0 - 0.2 + 1e-6
    assert pause.start >= 0.4 - 1e-6


def test_fillers_flags_risky_for_review_when_not_leaving_in():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.4),
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="uh", start=1.25, end=1.45),
        TranscriptWord(text="world", start=2.0, end=2.4),
    ]
    project = _project_with_transcript(words)
    risky = CutRisk(score=1.0, reasons=["harsh join"])
    with patch(
        "podcast_mcp.edits.fillers.optimize_and_assess",
        side_effect=lambda *a, **k: (_passthrough_opt(1.0, 1.2), risky),
    ):
        defaults = {
            "tighten": {
                "filler_words": ["um", "uh"],
                "max_pause_sec": 99.0,
                "min_filler_cluster": 2,
                "leave_in_if_risky": False,
            }
        }
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert len(project.edit_decisions) == 2
    assert all(e.review_required for e in project.edit_decisions)
    assert all(":risky" in (e.reason or "") for e in project.edit_decisions)


def test_extend_cut_for_breaths():
    start, end = extend_cut_for_breaths(
        1.0,
        1.2,
        [BreathSpan(start=0.85, end=1.0, side="before")],
    )
    assert start == pytest.approx(0.85)
    assert end == pytest.approx(1.2)


def test_assess_cut_risk_low_confidence_filler():
    project = _project_with_transcript(
        [TranscriptWord(text="um", start=1.0, end=1.2, confidence=0.05)]
    )
    risk = assess_cut_risk(
        project,
        "host",
        1.0,
        1.2,
        filler_confidence=0.05,
        boundary_confidence=0.2,
        defaults={"tighten": {"max_cut_risk_score": 0.65, "min_filler_confidence": 0.15}},
    )
    assert risk.score > 0.4
    assert any("confidence" in r for r in risk.reasons)


def test_recommend_cut_fade_ms_pause_longer_than_filler():
    project = _project_with_transcript([])
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=None,
    ):
        filler = recommend_cut_fade_ms(project, "host", 1.0, 1.2, cut_kind="filler")
        pause = recommend_cut_fade_ms(project, "host", 1.0, 2.5, cut_kind="pause")
    assert pause >= filler


def test_detect_adjacent_breath_disabled(defaults=None):
    from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole

    project = EpisodeProject.create("b", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=10.0),
        )
    ]
    with patch(
        "podcast_mcp.edits.breath_detect._breath_cfg",
        return_value={"enabled": False},
    ):
        assert detect_adjacent_breath(project, "host", 1.0, 1.2) == []


def test_optimize_and_assess_integration():
    from podcast_mcp.edits.cut_quality import optimize_and_assess
    from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole, Transcript

    project = EpisodeProject.create("o", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=10.0),
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=[])]
    with patch(
        "podcast_mcp.edits.cut_quality.optimize_source_cut_range",
    ) as opt:
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        opt.return_value = OptimizedCutRange(
            start=1.0,
            end=1.2,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.8,
            details={},
        )
        with patch(
            "podcast_mcp.edits.cut_quality.measure_join_jump_db",
            return_value=2.0,
        ):
            result, risk = optimize_and_assess(project, "host", 1.0, 1.2)
    assert result.start == 1.0
    assert not risk.too_risky


def test_word_margin_violation_detects_close_boundary():
    words = [
        TranscriptWord(text="a", start=0.0, end=0.5),
        TranscriptWord(text="b", start=0.52, end=1.0),
    ]
    project = _project_with_transcript(words)
    violation = word_margin_violation_sec(project, "host", 0.51, 0.52)
    assert violation > 0


def test_contiguous_retain_and_trim_edge_cases():
    from podcast_mcp.edits.fillers import (
        _contiguous_retain_before_word,
        _pause_trim_end_for_timeline_floor,
    )

    project = _project_with_transcript([TranscriptWord(text="Hi", start=0.0, end=0.2)])
    # No clip covers gap_end → empty retain sentinel.
    project.clips = []
    assert _contiguous_retain_before_word(project, "host", 5.0, 6.0) == (6.0, 6.0)

    # Word sits exactly at clip head → empty contiguous retain.
    project.clips = [
        Clip(
            id="only",
            track_id="host",
            source_start=2.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    rs, re = _contiguous_retain_before_word(project, "host", 0.5, 2.0)
    assert rs == pytest.approx(2.0)
    assert re == pytest.approx(2.0)
    assert _pause_trim_end_for_timeline_floor(project, "host", 0.5, 2.0, 0.55) == pytest.approx(
        1.98, abs=0.01
    )
    # Tiny gap → refuse trim.
    assert _pause_trim_end_for_timeline_floor(project, "host", 1.99, 2.0, 0.55) is None
    # Contiguous air already equals floor but trim would land at gap start → None.
    project.clips = [
        Clip(
            id="air",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    assert _pause_trim_end_for_timeline_floor(project, "host", 1.0, 1.55, 0.55) is None
    # Shortfall path: contiguous < floor but trim would be ≤ gap_start → None.
    project.clips = [
        Clip(
            id="short",
            track_id="host",
            source_start=1.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    assert _pause_trim_end_for_timeline_floor(project, "host", 1.0, 1.3, 0.55) is None


def _discourse_defaults(**overrides: object) -> dict:
    tighten: dict = {
        "filler_words": ["um", "uh", "erm", "ah", "like", "you know", "sort of", "kind of"],
        "discourse_markers": ["like", "you know", "sort of", "kind of"],
        "discourse_pause_sec": 0.35,
        "discourse_confidence_max": 0.6,
        "max_pause_sec": 99.0,
        "min_filler_cluster": 1,
        "filler_cluster_gap_sec": 2.0,
    }
    tighten.update(overrides)
    return {"tighten": tighten}


def _collect_with_skips(words: list[TranscriptWord], defaults: dict):
    from podcast_mcp.edits.fillers import _collect_candidates

    project = _project_with_transcript(words)
    skips: dict[str, int] = {}
    cands = _collect_candidates(
        project.transcripts[0], defaults, project=project, skip_counts=skips
    )
    return cands, skips


def test_discourse_quotative_like_kept():
    words = [
        TranscriptWord(text="she", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="was", start=0.21, end=0.4, confidence=0.95),
        TranscriptWord(text="like", start=0.41, end=0.6, confidence=0.95),
        TranscriptWord(text="no", start=0.61, end=0.8, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults())
    assert cands == []
    assert skips == {"discourse:like": 1}


def test_discourse_comparative_like_kept():
    words = [
        TranscriptWord(text="it's", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.21, end=0.4, confidence=0.95),
        TranscriptWord(text="a", start=0.41, end=0.55, confidence=0.95),
        TranscriptWord(text="box", start=0.56, end=0.8, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults())
    assert [c.reason for c in cands] == []
    assert skips["discourse:like"] == 1


def test_discourse_like_um_cluster_cut():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="um", start=0.42, end=0.6, confidence=0.95),
        TranscriptWord(text="world", start=0.8, end=1.0, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert {c.reason for c in cands} == {"filler:like", "filler:um"}
    assert skips == {}
    project = _project_with_transcript(words)
    analyze_fillers_and_pauses(
        project, project.transcripts[0], _discourse_defaults(min_filler_cluster=2)
    )
    assert {e.reason for e in project.edit_decisions} == {"filler:like", "filler:um"}


def test_discourse_like_like_repeat_cut():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="like", start=0.41, end=0.55, confidence=0.95),
        TranscriptWord(text="world", start=0.7, end=0.9, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert [c.reason for c in cands] == ["filler:like", "filler:like"]
    assert skips == {}


def test_discourse_pause_bounded_like_cut():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.95),
        TranscriptWord(text="like", start=0.8, end=1.0, confidence=0.95),
        TranscriptWord(text="world", start=1.05, end=1.3, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults())
    assert [c.reason for c in cands] == ["filler:like"]
    assert skips == {}


def test_discourse_low_confidence_like_cut():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.4),
        TranscriptWord(text="world", start=0.45, end=0.7, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults())
    assert [c.reason for c in cands] == ["filler:like"]
    assert skips == {}


def test_discourse_skip_counts_surfaced_in_summary():
    from podcast_mcp.edits.tighten import TightenProposal, format_tighten_propose_summary
    from podcast_mcp.models import EditDecision, EditDecisionType

    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="said", start=0.45, end=0.7, confidence=0.95),
        TranscriptWord(text="like", start=1.0, end=1.2, confidence=0.95),
        TranscriptWord(text="world", start=1.3, end=1.5, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert cands == []
    assert skips == {"discourse:like": 2}
    summary = format_tighten_propose_summary([], skips)
    assert "2 discourse kept" in summary
    proposal = TightenProposal(
        decisions=[
            EditDecision(
                id="1",
                track_id="host",
                type=EditDecisionType.REMOVE,
                start=0.3,
                end=0.5,
                reason="filler:um",
            )
        ],
        skip_counts=skips,
    )
    assert "1 discourse" not in proposal.summary()
    assert "2 discourse kept" in proposal.summary()
    assert "1 filler" in proposal.summary()


def test_discourse_config_defaults_round_trip():
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.fillers import (
        DEFAULT_DISCOURSE_CONFIDENCE_MAX,
        DEFAULT_DISCOURSE_MARKERS,
        DEFAULT_DISCOURSE_PAUSE_SEC,
    )
    from podcast_mcp.pipeline.meta import param_fields_payload
    from podcast_mcp.services.pipeline_config import merge_pipeline_config

    tighten = load_defaults()["tighten"]
    assert tighten["discourse_markers"] == list(DEFAULT_DISCOURSE_MARKERS)
    assert tighten["discourse_pause_sec"] == DEFAULT_DISCOURSE_PAUSE_SEC
    assert tighten["discourse_confidence_max"] == DEFAULT_DISCOURSE_CONFIDENCE_MAX
    assert tighten["discourse_markers"] == ["like", "you know", "sort of", "kind of"]
    assert tighten["discourse_pause_sec"] == 0.35
    assert tighten["discourse_confidence_max"] == 0.6
    merged = merge_pipeline_config({})
    assert merged["tighten"]["discourse_markers"] == tighten["discourse_markers"]
    assert merged["tighten"]["discourse_pause_sec"] == 0.35
    params = {p["path"]: p for p in param_fields_payload()}
    assert params["tighten.discourse_pause_sec"]["default"] == 0.35
    assert params["tighten.discourse_confidence_max"]["default"] == 0.6
    assert params["tighten.discourse_pause_sec"]["minimum"] == 0.0
    assert params["tighten.discourse_confidence_max"]["maximum"] == 1.0


def test_discourse_first_word_uses_trailing_pause():
    words = [
        TranscriptWord(text="like", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="hello", start=0.7, end=0.9, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults())
    assert [c.reason for c in cands] == ["filler:like"]
    assert skips == {}


def test_pause_analyze_skips_junk_words_when_padding_shortfall():
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    words = [
        TranscriptWord(text="one", start=0.0, end=0.4),
        TranscriptWord(text="x", start=1.0, end=1.0),
        TranscriptWord(text="y", start=1.2, end=1.4, suppressed=True),
        TranscriptWord(text="two", start=3.0, end=3.4),
    ]
    project = _project_with_transcript(words)
    project.clips = [
        Clip(
            id="late",
            track_id="host",
            source_start=2.6,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    result = _analyze_candidate(
        project,
        _CutCandidate(
            track_id="host",
            start=0.4,
            end=2.45,
            reason="pause:2.60s",
            cut_kind="pause",
            max_end=2.45,
        ),
        {
            "tighten": {
                "min_retained_pause_sec": 0.55,
                "min_retained_solo_pause_sec": 0.55,
            }
        },
    )
    assert result is not None
    assert result.replace_gap_sec is not None


def _pause_candidate(**kwargs):
    from podcast_mcp.edits.fillers import _CutCandidate

    fields = {
        "track_id": "host",
        "start": 0.4,
        "end": 2.0,
        "reason": "pause:1.60s",
        "cut_kind": "pause",
        "max_end": 2.0,
    }
    fields.update(kwargs)
    return _CutCandidate(**fields)


def test_pause_analyze_skips_pad_without_transcript_or_next_word():
    from podcast_mcp.edits.filler_pacing import FillerPacingResult
    from podcast_mcp.edits.fillers import _analyze_candidate

    paced = FillerPacingResult(start=0.4, end=2.0, replace_gap_sec=None)
    defaults = {
        "tighten": {
            "min_retained_pause_sec": 0.55,
            "min_retained_solo_pause_sec": 0.55,
        }
    }
    empty = _project_with_transcript([])
    empty.transcripts = []
    with patch("podcast_mcp.edits.fillers.apply_filler_pacing", return_value=paced):
        result = _analyze_candidate(empty, _pause_candidate(), defaults)
    assert result is not None
    assert result.replace_gap_sec is None

    junk_only = _project_with_transcript(
        [
            TranscriptWord(text="one", start=0.0, end=0.4),
            TranscriptWord(text="x", start=2.1, end=2.1),
            TranscriptWord(text="y", start=2.2, end=2.4, suppressed=True),
        ]
    )
    with patch("podcast_mcp.edits.fillers.apply_filler_pacing", return_value=paced):
        result = _analyze_candidate(junk_only, _pause_candidate(), defaults)
    assert result is not None
    assert result.replace_gap_sec is None


def test_pause_analyze_does_not_pad_when_next_word_is_flush():
    from podcast_mcp.edits.filler_pacing import FillerPacingResult
    from podcast_mcp.edits.fillers import _analyze_candidate

    words = [
        TranscriptWord(text="one", start=0.0, end=0.4),
        TranscriptWord(text="two", start=2.0, end=2.3),
    ]
    project = _project_with_transcript(words)
    paced = FillerPacingResult(start=0.4, end=2.0, replace_gap_sec=None)
    with patch("podcast_mcp.edits.fillers.apply_filler_pacing", return_value=paced):
        result = _analyze_candidate(
            project,
            _pause_candidate(),
            {
                "tighten": {
                    "min_retained_pause_sec": 0.55,
                    "min_retained_solo_pause_sec": 0.55,
                }
            },
        )
    assert result is not None
    assert result.replace_gap_sec is None


def test_analyze_returns_none_when_max_end_collapses_span():
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    project = _project_with_transcript([TranscriptWord(text="um", start=1.0, end=1.2)])
    result = _analyze_candidate(
        project,
        _CutCandidate(
            track_id="host",
            start=1.0,
            end=1.2,
            reason="filler:um",
            cut_kind="filler",
            max_end=0.5,
        ),
        {"tighten": {}},
    )
    assert result is None


def test_analyze_returns_none_when_cut_scope_is_skipped():
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    project = _project_with_transcript(
        [
            TranscriptWord(text="um", start=1.0, end=1.2),
            TranscriptWord(text="uh", start=1.25, end=1.45),
        ]
    )
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        side_effect=ValueError("cut blocked"),
    ):
        result = _analyze_candidate(
            project,
            _CutCandidate(
                track_id="host",
                start=1.0,
                end=1.45,
                reason="filler:um",
                cut_kind="filler",
            ),
            {"tighten": {}},
        )
    assert result is None


def test_analyze_marks_review_when_peer_speech_requires_it():
    from types import SimpleNamespace

    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    project = _project_with_transcript(
        [
            TranscriptWord(text="um", start=1.0, end=1.2),
            TranscriptWord(text="uh", start=1.25, end=1.45),
        ]
    )
    guard = SimpleNamespace(blocked=True, action="review", blocking_track_ids=["guest"])
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        return_value=("track", guard),
    ):
        result = _analyze_candidate(
            project,
            _CutCandidate(
                track_id="host",
                start=1.0,
                end=1.45,
                reason="filler:um",
                cut_kind="filler",
            ),
            {"tighten": {}},
        )
    assert result is not None
    assert result.review_required is True
    assert "other_speaking:guest" in result.reason
    assert result.replace_gap_sec is None
    assert result.scope == "track"


def test_discourse_trailing_pause_qualifies_like():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.3, confidence=0.95),
        TranscriptWord(text="like", start=0.4, end=0.55, confidence=0.95),
        TranscriptWord(text="world", start=1.0, end=1.2, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults())
    assert [c.reason for c in cands] == ["filler:like"]
    assert skips == {}


def test_discourse_you_know_split_tokens_kept():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="you", start=0.21, end=0.35, confidence=0.95),
        TranscriptWord(text="know", start=0.36, end=0.5, confidence=0.95),
        TranscriptWord(text="world", start=0.55, end=0.8, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=1))
    assert cands == []
    assert skips == {"discourse:you know": 1}


def test_discourse_sort_of_and_kind_of_split_tokens_kept():
    words = [
        TranscriptWord(text="it's", start=0.0, end=0.15, confidence=0.95),
        TranscriptWord(text="sort", start=0.16, end=0.3, confidence=0.95),
        TranscriptWord(text="of", start=0.31, end=0.4, confidence=0.95),
        TranscriptWord(text="fine", start=0.41, end=0.55, confidence=0.95),
        TranscriptWord(text="that's", start=3.0, end=3.15, confidence=0.95),
        TranscriptWord(text="kind", start=3.16, end=3.3, confidence=0.95),
        TranscriptWord(text="of", start=3.31, end=3.45, confidence=0.95),
        TranscriptWord(text="ok", start=3.46, end=3.6, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=1))
    assert cands == []
    assert skips == {"discourse:sort of": 1, "discourse:kind of": 1}


def test_discourse_you_know_um_adjacent_cut():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="you", start=0.21, end=0.35, confidence=0.95),
        TranscriptWord(text="know", start=0.36, end=0.5, confidence=0.95),
        TranscriptWord(text="um", start=0.52, end=0.7, confidence=0.95),
        TranscriptWord(text="world", start=0.8, end=1.0, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert {c.reason for c in cands} == {"filler:you know", "filler:um"}
    assert skips == {}


def test_discourse_like_not_promoted_by_distant_um():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="a", start=0.41, end=0.5, confidence=0.95),
        TranscriptWord(text="box", start=0.51, end=0.7, confidence=0.95),
        TranscriptWord(text="um", start=1.5, end=1.7, confidence=0.95),
        TranscriptWord(text="world", start=1.8, end=2.0, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert [c.reason for c in cands] == ["filler:um"]
    assert skips == {"discourse:like": 1}


def test_discourse_isolated_like_respects_min_cluster():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="world", start=0.45, end=0.7, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert cands == []
    assert skips == {"discourse:like": 1}


def test_analyze_fillers_and_pauses_records_discourse_skips():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="world", start=0.45, end=0.7, confidence=0.95),
    ]
    project = _project_with_transcript(words)
    skips: dict[str, int] = {}
    decisions = analyze_fillers_and_pauses(
        project,
        project.transcripts[0],
        _discourse_defaults(min_filler_cluster=2),
        skip_counts=skips,
    )
    assert decisions == []
    assert skips == {"discourse:like": 1}


def test_discourse_empty_markers_cuts_like_as_filler():
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="world", start=0.45, end=0.7, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(
        words, _discourse_defaults(discourse_markers=[], min_filler_cluster=1)
    )
    assert [c.reason for c in cands] == ["filler:like"]
    assert skips == {}


def test_discourse_immediate_repeat_skips_suppressed_neighbors():
    words = [
        TranscriptWord(text="like", start=0.2, end=0.35, confidence=0.95),
        TranscriptWord(text="x", start=0.36, end=0.4, confidence=0.95, suppressed=True),
        TranscriptWord(text="like", start=0.41, end=0.55, confidence=0.95),
        TranscriptWord(text="world", start=0.7, end=0.9, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert [c.reason for c in cands] == ["filler:like", "filler:like"]
    assert skips == {}


def test_discourse_leading_silence_and_trailing_like():
    from podcast_mcp.edits.fillers import _collect_candidates
    from podcast_mcp.edits.tighten import format_tighten_propose_summary

    leading = [
        TranscriptWord(text="like", start=0.5, end=0.7, confidence=0.95),
        TranscriptWord(text="hello", start=0.75, end=1.0, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(leading, _discourse_defaults())
    assert [c.reason for c in cands] == ["filler:like"]
    assert skips == {}

    trailing = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(trailing, _discourse_defaults())
    assert cands == []
    assert skips == {"discourse:like": 1}
    project = _project_with_transcript(trailing)
    bare = _collect_candidates(project.transcripts[0], _discourse_defaults(), project=project)
    assert bare == []
    assert format_tighten_propose_summary([]) == "0 proposed (0 filler, 0 pause)"


def test_discourse_bounds_reject_invalid_numbers():
    from podcast_mcp.config import bounded_float

    assert bounded_float("nope", 0.35, 0.0, 5.0) == 0.35
    assert bounded_float(None, 0.35, 0.0, 5.0) == 0.35
    assert bounded_float(float("inf"), 0.35, 0.0, 5.0) == 0.35
    assert bounded_float(float("nan"), 0.35, 0.0, 5.0) == 0.35
    assert bounded_float(-1.0, 0.35, 0.0, 5.0) == 0.0
    assert bounded_float(99.0, 0.35, 0.0, 5.0) == 5.0
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="like", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="world", start=0.45, end=0.7, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(
        words,
        _discourse_defaults(
            discourse_pause_sec="bad",
            discourse_confidence_max=None,
            discourse_markers=["  ", "like"],
        ),
    )
    assert cands == []
    assert skips == {"discourse:like": 1}


def test_analyze_skips_when_filler_pacing_returns_none():
    words = [
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="uh", start=1.25, end=1.45),
    ]
    project = _project_with_transcript(words)
    with patch("podcast_mcp.edits.fillers.apply_filler_pacing", return_value=None):
        decisions = analyze_fillers_and_pauses(
            project,
            project.transcripts[0],
            {
                "tighten": {
                    "filler_words": ["um", "uh"],
                    "max_pause_sec": 99.0,
                    "min_filler_cluster": 2,
                }
            },
        )
    assert decisions == []


def test_join_continuity_verdicts_and_scorer_errors():
    from types import SimpleNamespace

    words = [
        TranscriptWord(text="um", start=1.0, end=1.2),
        TranscriptWord(text="uh", start=1.25, end=1.45),
    ]
    defaults = {
        "tighten": {
            "filler_words": ["um", "uh"],
            "max_pause_sec": 99.0,
            "min_filler_cluster": 2,
            "join_continuity_gate": True,
        }
    }
    sentinel_cache = object()
    project = _project_with_transcript(words)
    with (
        patch(
            "podcast_mcp.edits.fillers.build_track_audio_caches",
            return_value={"host": sentinel_cache},
        ),
        patch(
            "podcast_mcp.edits.join_continuity.assess_proposed_cut",
            return_value=SimpleNamespace(verdict="review"),
        ) as assess,
    ):
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert assess.call_args.kwargs["audio_caches"] == {"host": sentinel_cache}
    assert assess.call_args.kwargs["audio_caches"]["host"] is sentinel_cache

    project = _project_with_transcript(words)
    with patch(
        "podcast_mcp.edits.join_continuity.assess_proposed_cut",
        return_value=SimpleNamespace(verdict="fail"),
    ) as assess:
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions == []
    assert assess.call_args.kwargs["audio_caches"] is None

    project = _project_with_transcript(words)
    with patch(
        "podcast_mcp.edits.join_continuity.assess_proposed_cut",
        return_value=SimpleNamespace(verdict="review"),
    ):
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions
    assert all(e.review_required for e in project.edit_decisions)
    assert all(":join_review" in (e.reason or "") for e in project.edit_decisions)

    project = _project_with_transcript(words)
    with patch(
        "podcast_mcp.edits.join_continuity.assess_proposed_cut",
        side_effect=RuntimeError("scorer down"),
    ):
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions


def test_repetition_candidates_flag_off_skips_repetition():
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="the", start=0.0, end=0.15),
        TranscriptWord(text="the", start=0.17, end=0.3),
        TranscriptWord(text="store", start=0.35, end=0.6),
    ]
    project = _project_with_transcript(words)
    off = {"tighten": {"filler_words": [], "repetition_candidates": False}}
    assert _collect_candidates(project.transcripts[0], off, project=project) == []
    on = {"tighten": {"filler_words": []}}
    found = _collect_candidates(project.transcripts[0], on, project=project)
    assert [c.reason for c in found] == ["repetition:word:the"]


def test_intensity_tiers_are_nested_and_ordered():
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.fillers import _collect_candidates
    from podcast_mcp.edits.tighten_intensity import apply_tighten_intensity

    spec = [
        ("so", 0.0, 0.2, 0.95),
        ("um", 0.25, 0.4, 0.95),
        ("uh", 0.45, 0.6, 0.95),
        ("we", 0.65, 0.8, 0.95),
        ("like", 0.85, 1.0, 0.7),
        ("went", 1.05, 1.3, 0.95),
        ("the", 1.35, 1.5, 0.95),
        ("the", 1.52, 1.7, 0.95),
        ("store", 1.75, 2.0, 0.95),
        ("then", 3.0, 3.2, 0.95),
        ("okay", 5.8, 6.0, 0.95),
        ("um", 6.05, 6.2, 0.95),
        ("right", 6.25, 6.5, 0.95),
    ]
    words = [TranscriptWord(text=t, start=s, end=e, confidence=c) for t, s, e, c in spec]
    project = _project_with_transcript(words)
    hits: dict[str, list] = {}
    for name in ("light", "medium", "aggressive"):
        tighten = apply_tighten_intensity(load_defaults()["tighten"], name)
        cands = _collect_candidates(project.transcripts[0], {"tighten": tighten}, project=project)
        hits[name] = sorted(cands, key=lambda c: c.start)

    def keys(name):
        return [(c.reason, round(c.start, 2)) for c in hits[name]]

    assert keys("light") == [("filler:um", 0.25), ("filler:uh", 0.45), ("pause:2.60s:solo", 3.2)]
    assert set(keys("light")) < set(keys("medium")) < set(keys("aggressive"))
    assert ("repetition:word:the", 1.35) in keys("medium")
    assert ("filler:like", 0.85) in keys("aggressive")
    pause_ends = [
        next(c.end for c in hits[n] if c.reason.startswith("pause") and round(c.start, 2) == 3.2)
        for n in hits
    ]
    assert pause_ends[0] < pause_ends[1] < pause_ends[2]


def test_propose_tighten_edits_resolves_intensity(monkeypatch):
    from podcast_mcp.edits import tighten as tighten_module

    project = _project_with_transcript([TranscriptWord(text="hi", start=0.0, end=0.2)])
    seen: list[dict] = []

    def fake_collect(_transcript, defaults, **_kwargs):
        seen.append(defaults["tighten"])
        return []

    monkeypatch.setattr(tighten_module, "build_track_audio_caches", lambda *_a: {})
    monkeypatch.setattr(tighten_module, "_add_acoustic_candidates", lambda cands, *_a, **_k: cands)
    monkeypatch.setattr(tighten_module, "_collect_candidates", fake_collect)

    tighten_module.propose_tighten_edits(project, {"tighten": {"intensity": "light"}})
    assert seen[-1]["max_pause_sec"] == 2.0
    tighten_module.propose_tighten_edits(
        project, {"tighten": {"intensity": "light"}}, intensity="aggressive"
    )
    assert seen[-1]["max_pause_sec"] == 0.8
    assert seen[-1]["intensity"] == "aggressive"

    before = list(project.edit_decisions)
    with pytest.raises(ValueError):
        tighten_module.propose_tighten_edits(project, {"tighten": {}}, intensity="bogus")
    assert project.edit_decisions == before


def test_analyze_fillers_and_pauses_resolves_intensity(monkeypatch):
    from podcast_mcp.edits import fillers as fillers_module

    project = _project_with_transcript([TranscriptWord(text="hi", start=0.0, end=0.2)])
    seen: list[dict] = []

    def fake_collect(_transcript, defaults, **_kwargs):
        seen.append(defaults["tighten"])
        return []

    monkeypatch.setattr(fillers_module, "build_track_audio_caches", lambda *_a: {})
    monkeypatch.setattr(fillers_module, "_add_acoustic_candidates", lambda cands, *_a, **_k: cands)
    monkeypatch.setattr(fillers_module, "_collect_candidates", fake_collect)

    fillers_module.analyze_fillers_and_pauses(
        project, project.transcripts[0], {"tighten": {"intensity": "light"}}
    )
    assert seen[-1]["max_pause_sec"] == 2.0
    assert seen[-1]["intensity"] == "light"
