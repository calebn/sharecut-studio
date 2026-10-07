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
from podcast_mcp.edits.fillers import _CutRejected, analyze_fillers_and_pauses
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


def test_peer_speech_index_matches_direct_gap_scan() -> None:
    from podcast_mcp.edits.fillers import _peer_speaking_in_gap, _peer_speech_indexes

    project = _project_with_transcript([])
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    project.transcripts.append(
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="late", start=3.0, end=3.4),
                TranscriptWord(text="muted", start=1.0, end=1.3, suppressed=True),
                TranscriptWord(text="early", start=2.0, end=2.2),
                TranscriptWord(text="point", start=1.4, end=1.4),
            ],
        )
    )
    indexes = _peer_speech_indexes(project)
    for start, end in (
        (0, 1.1),
        (1.3, 1.5),
        (1.4, 1.5),
        (1.3, 1.4),
        (1.5, 2.1),
        (2.2, 3.1),
        (3.4, 4.0),
    ):
        assert _peer_speaking_in_gap(project, "host", start, end, indexes) == (
            _peer_speaking_in_gap(project, "host", start, end)
        )


def test_peer_speech_index_falls_back_for_standalone_transcript() -> None:
    from podcast_mcp.edits.fillers import _peer_speaking_in_gap, _peer_speech_indexes

    project = _project_with_transcript([TranscriptWord(text="peer", start=2.0, end=2.4)])
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    indexes = _peer_speech_indexes(project)
    assert "guest" not in indexes
    assert _peer_speaking_in_gap(project, "guest", 2.1, 2.3, indexes)
    assert not _peer_speaking_in_gap(project, "guest", 2.4, 2.6, indexes)


def test_peer_speech_index_excludes_own_long_word_across_three_tracks(monkeypatch) -> None:
    from podcast_mcp.edits.fillers import (
        _peer_speaking_in_gap,
        _peer_speech_indexes,
        _PeerSpeechIndex,
    )

    project = _project_with_transcript([TranscriptWord(text="host", start=0.0, end=20.0)])
    for track_id, role, words in (
        (
            "guest",
            TrackRole.DIALOGUE,
            [
                TranscriptWord(text="late", start=8.0, end=9.0),
                TranscriptWord(text="early", start=1.0, end=2.0),
                TranscriptWord(text="muted", start=4.0, end=5.0, suppressed=True),
            ],
        ),
        ("third", TrackRole.DIALOGUE, [TranscriptWord(text="third", start=11.0, end=12.0)]),
        ("music", TrackRole.MUSIC, [TranscriptWord(text="song", start=6.0, end=7.0)]),
    ):
        project.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=role,
                media=MediaAsset(path=f"/tmp/ws/raw/{track_id}.wav", duration_sec=30.0),
            )
        )
        project.transcripts.append(Transcript(track_id=track_id, words=words))

    built: list[int] = []
    original = _PeerSpeechIndex.build

    def counted(spans):
        items = list(spans)
        built.append(len(items))
        return original(items)

    monkeypatch.setattr(_PeerSpeechIndex, "build", staticmethod(counted))
    indexes = _peer_speech_indexes(project)
    assert built == [4]  # One global pass; muted and music words are omitted.
    assert len({id(index.shared) for index in indexes.values()}) == 1
    for track_id in ("host", "guest", "third", "music"):
        for start, end in (
            (0.0, 1.0),
            (1.0, 2.0),
            (2.0, 4.0),
            (4.0, 5.0),
            (6.0, 7.0),
            (8.0, 9.0),
            (9.0, 11.0),
            (11.0, 12.0),
            (12.0, 20.0),
            (20.0, 21.0),
        ):
            assert _peer_speaking_in_gap(project, track_id, start, end, indexes) == (
                _peer_speaking_in_gap(project, track_id, start, end)
            )
    assert not indexes["host"].overlaps(6.0, 7.0)
    assert indexes["host"].overlaps(8.0, 9.0)
    assert indexes["guest"].overlaps(6.0, 7.0)


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


def _write_speech_wav(path, spans: list[tuple[float, float]], *, rate: int = 48_000) -> None:
    import wave

    import numpy as np

    samples = np.zeros(5 * rate, dtype=np.float32)
    for start, end in spans:
        n = int((end - start) * rate)
        t = np.arange(n) / rate
        tone = sum(np.sin(2 * np.pi * 180.0 * k * t) / k for k in range(1, 6))
        tone = tone / np.sqrt(np.mean(tone**2)) * 10 ** (-20.0 / 20)
        samples[int(start * rate) : int(start * rate) + n] = tone.astype(np.float32)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())


def test_analyze_fillers_integration(tmp_path):
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    _write_speech_wav(raw / "host.wav", [(0.5, 0.7), (0.75, 0.95), (2.0, 2.4)])

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

    defaults = load_defaults()
    # This gated speech fixture has no measurable room-tone contrast.
    defaults["tighten"]["breath_handling"]["enabled"] = False
    decision, padded = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)

    assert decision.reason == "filler:um"
    assert decision.review_required is False
    assert decision.scope == "session"
    assert decision.start == pytest.approx(0.460, abs=0.011)
    assert decision.end == pytest.approx(0.702, abs=0.005)
    assert decision.cut_confidence is not None
    # The uh is paced up to "hello" with a pad, so no splice gate scores its edges.
    assert (padded.reason, padded.review_required, padded.replace_gap_sec) == (
        "filler:uh",
        False,
        1.0,
    )
    assert (padded.start, padded.end) == pytest.approx((0.705, 1.92), abs=0.005)


@pytest.fixture(autouse=True)
def _mock_cut_pipeline(request):
    if request.node.name.startswith(("test_analyze_fillers_integration", "test_audio_padded_")):
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
            "podcast_mcp.edits.fillers.protect_cut_breaths",
            side_effect=lambda project, track_id, start, end, **kw: (start, end),
        ),
        patch(
            "podcast_mcp.edits.fillers.pause_air_span",
            side_effect=lambda project, track_id, start, end, **kw: (start, end),
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


def test_pause_across_ripple_deleted_material_is_not_proposed():
    """A ripple delete leaves no clip over the removed source range.

    Two words that are adjacent in the surviving transcript can still be far
    apart on the source clock (#772): the material between them was already
    cut from the timeline, so a source-clock gap check would find one even
    though nothing plays there any more. The next clip starts flush with the
    resume word, so none of the gap survives on the timeline.
    """
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="her", start=2.5, end=2.8),
        TranscriptWord(text="anyway", start=80.3, end=80.6),
        TranscriptWord(text="great", start=82.0, end=82.3),
    ]
    project = _project_with_transcript(words)
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=3.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=80.3, source_end=90.0, timeline_start=3.0),
    ]
    candidates = _collect_candidates(
        project.transcripts[0],
        {"tighten": {"filler_words": [], "max_pause_sec": 1.2}},
        project=project,
    )
    # The her->anyway gap sits almost entirely on ripple-deleted source (only
    # 0.2s survives, 2.8->3.0), so it is dropped rather than proposed off the
    # much larger 77.5s source-clock distance. The anyway->great gap sits
    # entirely inside the surviving clip, so it is measured and proposed
    # normally (#783) -- pinning this literal survivor shows the drop above
    # is the ripple check doing its job, not the collector finding nothing.
    assert [(c.reason, c.start, c.end) for c in candidates] == [
        ("pause:1.40s:solo", pytest.approx(80.6), pytest.approx(81.45))
    ]


def test_pause_gap_is_measured_on_the_timeline_not_the_source_clock():
    """A partially ripple-deleted gap is sized by what still plays, not raw source distance."""
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="her", start=4.2, end=4.5),
        TranscriptWord(text="anyway", start=16.0, end=16.3),
    ]
    project = _project_with_transcript(words)
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=15.0, source_end=30.0, timeline_start=5.0),
    ]
    candidates = _collect_candidates(
        project.transcripts[0],
        {"tighten": {"filler_words": [], "max_pause_sec": 1.2}},
        project=project,
    )
    # Raw source distance is 11.5s (16.0 - 4.5); surviving timeline air is only
    # 0.5s (4.5->5.0) + 1.0s (15.0->16.0) = 1.5s.
    assert [c.reason for c in candidates] == ["pause:1.50s:solo"]


def test_timeline_pause_gap_sec_excludes_a_hole_inside_the_gap():
    """A hole already cut from this track does not count toward pause air (#783).

    ``_timeline_pause_gap_sec`` sums only clip-covered spans (#772). A hole
    inside the gap -- whether from a session-wide ripple or an earlier
    track-local punch -- is already-removed material either way from this
    single-track sum's point of view, so it is excluded the same as the
    ripple case above. This is a deliberate undercount, documented in
    docs/filler-cut-quality.md: it can only make ``max_pause_sec`` harder to
    reach, never propose a cut over audio that still plays.
    """
    from podcast_mcp.edits.fillers import _timeline_pause_gap_sec

    project = _project_with_transcript([])
    project.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.5, timeline_start=0.0),
        # 0.2s hole: source 1.5->1.7 has no clip for "host".
        Clip(id="b", track_id="host", source_start=1.7, source_end=100.0, timeline_start=1.5),
    ]
    # Wall-clock source distance is 1.3s (1.0->2.3); the 0.2s hole leaves 1.1s.
    assert _timeline_pause_gap_sec(project, "host", 1.0, 2.3) == pytest.approx(1.1)


def test_pause_dropped_below_threshold_because_of_a_hole_inside_the_gap():
    """The excluded hole (above) can tip a real pause below ``max_pause_sec`` (#783)."""
    from podcast_mcp.edits.fillers import _collect_candidates

    words = [
        TranscriptWord(text="so", start=0.0, end=1.0),
        TranscriptWord(text="anyway", start=2.3, end=2.6),
    ]
    tighten = {"tighten": {"filler_words": [], "max_pause_sec": 1.2}}

    with_hole = _project_with_transcript(words)
    with_hole.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.5, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.7, source_end=100.0, timeline_start=1.5),
    ]
    # 1.3s wall-clock gap minus the 0.2s hole leaves 1.1s -- under max_pause_sec.
    assert _collect_candidates(with_hole.transcripts[0], tighten, project=with_hole) == []

    without_hole = _project_with_transcript(words)
    without_hole.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=100.0, timeline_start=0.0),
    ]
    # Same 1.3s wall-clock gap, no hole: clears max_pause_sec and is proposed.
    candidates = _collect_candidates(without_hole.transcripts[0], tighten, project=without_hole)
    assert [(c.reason, c.start, c.end) for c in candidates] == [
        ("pause:1.30s:solo", pytest.approx(1.0), pytest.approx(1.75))
    ]


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


def test_bounded_repeat_start_skips_a_suppressed_neighbor():
    """The floor is the preceding *surviving* word, not just ``words[i - 1]`` (PR #792 review).

    A suppressed word can sit between two kept words with a span that
    overlaps the kept one before it (already-cut material). Reading
    ``words[i - 1]`` directly, ignoring suppression, can float the floor
    inside audio that still plays.
    """
    from podcast_mcp.edits.fillers import _bounded_repeat_start

    words = [
        TranscriptWord(text="well", start=1.0, end=1.5),
        TranscriptWord(text="mm", start=1.1, end=1.2, suppressed=True),
        TranscriptWord(text="that", start=1.5, end=1.7),
        TranscriptWord(text="that", start=1.72, end=1.9),
    ]
    # words[2 - 1] (the suppressed "mm") ends at 1.2, inside "well"'s kept
    # span (1.0-1.5); the correct floor is the end of "well" itself, 1.5.
    assert _bounded_repeat_start(words, 2) == pytest.approx(1.5)


def test_marked_partial_restart_is_bounded_by_flanking_silence():
    """The explicit-marker restart path's bound is unpinned without this (PR #792 review)."""
    from podcast_mcp.edits.fillers import _collect_repetition_candidates

    words = [
        TranscriptWord(text="well", start=0.0, end=0.3),
        TranscriptWord(text="stor-", start=0.5, end=0.7),
        TranscriptWord(text="store", start=0.85, end=1.05),
    ]
    candidates = _collect_repetition_candidates(words, "host", {"filler_words": []})
    assert [c.reason for c in candidates] == ["restart:partial:stor"]
    assert candidates[0].min_start == pytest.approx(0.3)
    assert candidates[0].max_end == pytest.approx(0.85)


def test_split_partial_restart_is_bounded_by_flanking_silence():
    """The split-repair restart path's bound is unpinned without this (PR #792 review)."""
    from podcast_mcp.edits.fillers import _collect_repetition_candidates

    words = [
        TranscriptWord(text="well", start=0.0, end=0.2),
        TranscriptWord(text="I", start=0.5, end=0.6),
        TranscriptWord(text="w-", start=0.62, end=0.7),
        TranscriptWord(text="I", start=0.72, end=0.82),
        TranscriptWord(text="went", start=0.95, end=1.13),
    ]
    candidates = _collect_repetition_candidates(words, "host", {"filler_words": []})
    assert [c.reason for c in candidates] == ["restart:partial:w"]
    assert candidates[0].min_start == pytest.approx(0.2)
    assert candidates[0].max_end == pytest.approx(0.95)


def test_restart_phrase_is_bounded_by_flanking_silence():
    """The phrase-restart path's bound is unpinned without this (PR #792 review)."""
    from podcast_mcp.edits.fillers import _collect_repetition_candidates

    words = [
        TranscriptWord(text="well", start=0.0, end=0.2),
        TranscriptWord(text="I", start=0.5, end=0.6),
        TranscriptWord(text="went", start=0.62, end=0.8),
        TranscriptWord(text="I", start=0.95, end=1.05),
        TranscriptWord(text="went", start=1.07, end=1.25),
    ]
    candidates = _collect_repetition_candidates(words, "host", {"filler_words": []})
    assert [c.reason for c in candidates] == ["restart:phrase:i went"]
    assert candidates[0].min_start == pytest.approx(0.2)
    assert candidates[0].max_end == pytest.approx(0.95)


def test_repeat_cut_dropped_when_it_barely_touches_the_reparandum():
    """A repeat/restart cut that ends up mostly outside its target word is junk (PR #792 review).

    Widening a repeat/restart cut's bounds to the flanking silence (#783)
    gives waveform snapping room to slide well away from the reparandum. A
    cut with less than half its overlap on the reparandum's own span removes
    neither copy and leaves both audible; reject it instead of proposing a
    no-op edit. The lab-verified case is aligned times slivering
    ``repetition:word:i`` at 215.81 without touching either "I".
    """
    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    words = [
        TranscriptWord(text="I", start=0.5, end=0.53),
        TranscriptWord(text="I", start=0.6, end=0.65),
    ]
    project = _project_with_transcript(words)
    cand = _CutCandidate(
        track_id="host",
        start=0.5,
        end=0.53,
        reason="repetition:word:i",
        cut_kind="repeat",
        min_start=0.2,
        max_end=0.6,
    )

    def fake_opt(*args, **kwargs):
        # Slides past the targeted "I" entirely, into the flanking silence.
        return (
            OptimizedCutRange(
                start=0.54,
                end=0.57,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.9,
                details={},
            ),
            CutRisk(score=0.0, reasons=[]),
        )

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=fake_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
    ):
        result = _analyze_candidate(
            project,
            cand,
            {"tighten": {"filler_words": [], "leave_in_if_risky": True}},
        )
    assert result == _CutRejected("reparandum")


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
    assert candidates[0].min_start == pytest.approx(0.0)
    # Bounded by the second "I"'s start (#783), not the cut word's own end: the
    # 0.03s gap between the two words is fair game for the waveform optimizer.
    assert candidates[0].max_end == pytest.approx(0.18)
    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], {"tighten": {"filler_words": []}}
    )
    assert decisions[0].review_required is True


def test_repetition_cut_cannot_widen_past_the_duplicate_word():
    """Waveform snapping may use the flanking silence but never a neighbor word (#772, #783).

    Before #772's bound, the join-quality optimizer was free to slide the cut
    onto whatever low-energy point it liked, which could land on the word
    before the repeat or eat into the kept second copy. Before #783's fix,
    the bound clamped to the reparandum's own start/end, which on aligned
    (gapped) word times stranded the flanking silence as unremoved air. The
    candidate here comes from the real collector, with a gap on each side of
    the repeated "what,", so the assertion exercises production bounds
    (0.9-1.35) rather than a hand-set stand-in for them.
    """
    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.fillers import _analyze_candidate, _collect_repetition_candidates
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    words = [
        TranscriptWord(text="audra", start=0.5, end=0.9),
        TranscriptWord(text="what,", start=1.0, end=1.3),
        TranscriptWord(text="what", start=1.35, end=1.55),
        TranscriptWord(text="comes", start=1.6, end=1.9),
    ]
    project = _project_with_transcript(words)
    candidates = _collect_repetition_candidates(words, "host", {"filler_words": []})
    assert [c.reason for c in candidates] == ["repetition:word:what"]
    cand = candidates[0]
    assert cand.min_start == pytest.approx(0.9)
    assert cand.max_end == pytest.approx(1.35)

    def fake_opt(*args, **kwargs):
        # Suggests sliding onto "audra"/"comes", well past the duplicate word
        # this candidate identified.
        return (
            OptimizedCutRange(
                start=0.2,
                end=1.9,
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
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
    ):
        result = _analyze_candidate(
            project,
            cand,
            {"tighten": {"filler_words": [], "leave_in_if_risky": True}},
        )
    assert result is not None
    # Clamped to the silence on each side of "what," (#783), not onto "audra"
    # or the kept second "what".
    assert result.start == pytest.approx(0.9)
    assert result.end == pytest.approx(1.35)


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

    def analyze(_project, candidate, _defaults, *, audio_cache=None, **_context):
        return _AnalyzedCut(
            hit_id=candidate.hit_id,
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


@pytest.mark.parametrize(("intensity", "expected"), [("medium", ["filler:um"]), ("light", [])])
def test_isolated_hard_filler_proposed_at_medium_not_light(intensity, expected):
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.4),
        TranscriptWord(text="Um.", start=1.0, end=1.2, confidence=0.9),
        TranscriptWord(text="world", start=2.0, end=2.4),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {
            "intensity": intensity,
            "filler_words": ["um"],
            "max_pause_sec": 99.0,
            "min_filler_cluster": 2,
        }
    }
    analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert [e.reason for e in project.edit_decisions] == expected


def test_punctuated_asr_fillers_match_the_lexicon():
    words = [
        TranscriptWord(text="So,", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="Uh,", start=0.25, end=0.4, confidence=0.95),
        TranscriptWord(text="you", start=0.45, end=0.55, confidence=0.95),
        TranscriptWord(text="know,", start=0.56, end=0.7, confidence=0.95),
        TranscriptWord(text="it's", start=0.75, end=0.9, confidence=0.95),
        TranscriptWord(text="Um.", start=5.0, end=5.3, confidence=0.95),
        TranscriptWord(text="fine.", start=5.35, end=5.6, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(
        words, _discourse_defaults(min_filler_cluster=2, filler_words=["UM", "uh,", "you know"])
    )
    assert [(c.reason, c.start, c.end) for c in cands] == [
        ("filler:uh", 0.25, 0.4),
        ("filler:you know", 0.45, 0.7),
        ("filler:um", 5.0, 5.3),
    ]
    assert skips == {}


def test_isolated_punctuated_discourse_marker_still_demoted():
    words = [
        TranscriptWord(text="she", start=0.0, end=0.2, confidence=0.95),
        TranscriptWord(text="was", start=0.21, end=0.4, confidence=0.95),
        TranscriptWord(text="like,", start=0.41, end=0.6, confidence=0.95),
        TranscriptWord(text="no.", start=0.61, end=0.8, confidence=0.95),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert cands == []
    assert skips == {"discourse:like": 1}


def _shipped_tighten_defaults() -> dict:
    from podcast_mcp.config import load_defaults

    return {"tighten": {**load_defaults()["tighten"], "max_pause_sec": 99.0}}


def test_split_uh_huh_is_a_backchannel_skip_not_a_filler():
    from podcast_mcp.edits.tighten import format_tighten_propose_summary

    words = [
        TranscriptWord(text="Uh", start=1.04, end=2.44, confidence=0.06),
        TranscriptWord(text="-huh.", start=2.44, end=2.56, confidence=0.8),
        TranscriptWord(text="Uh", start=3.6, end=4.0, confidence=0.87),
        TranscriptWord(text="-huh.", start=4.0, end=4.0, confidence=0.95),
        TranscriptWord(text="Wait,", start=4.1, end=4.3, confidence=0.9),
        TranscriptWord(text="Mm-hmm.", start=4.5, end=4.8, confidence=0.9),
        TranscriptWord(text="Mm-hmm.", start=4.85, end=5.1, confidence=0.9),
        TranscriptWord(text="Uh,", start=9.0, end=9.3, confidence=0.9),
        TranscriptWord(text="right.", start=9.35, end=9.6, confidence=0.9),
    ]
    cands, skips = _collect_with_skips(words, _shipped_tighten_defaults())
    assert [(c.reason, c.start) for c in cands] == [("filler:uh", 9.0)]
    assert skips == {"backchannel:uh huh": 2, "backchannel:mm-hmm": 2}
    assert format_tighten_propose_summary([], skips) == (
        "0 proposed (0 filler, 0 pause, 4 backchannel kept)"
    )


def test_uh_huh_with_a_suppressed_half_is_still_a_backchannel():
    words = [
        TranscriptWord(text="Uh", start=1.0, end=1.4, confidence=0.1),
        TranscriptWord(text="-huh.", start=1.4, end=1.4, suppressed=True),
        TranscriptWord(text="Wait,", start=1.4, end=1.4, suppressed=True),
        TranscriptWord(text="Uh", start=3.0, end=3.5, suppressed=True),
        TranscriptWord(text="-huh.", start=3.5, end=4.0, confidence=0.3),
        TranscriptWord(text="Uh,", start=9.0, end=9.3, confidence=0.9),
        TranscriptWord(text="right.", start=9.35, end=9.6, confidence=0.9),
    ]
    cands, skips = _collect_with_skips(words, _shipped_tighten_defaults())
    assert [(c.reason, c.start) for c in cands] == [("filler:uh", 9.0)]
    assert skips == {"backchannel:uh huh": 1}


def test_backchannel_wins_over_a_filler_entry_with_the_same_text():
    words = [
        TranscriptWord(text="So", start=0.0, end=0.2),
        TranscriptWord(text="mhm,", start=0.3, end=0.6),
        TranscriptWord(text="yes.", start=0.7, end=0.9),
    ]
    defaults = _discourse_defaults(filler_words=["mhm"], backchannels=["mhm"])
    cands, skips = _collect_with_skips(words, defaults)
    assert cands == []
    assert skips == {"backchannel:mhm": 1}


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
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            side_effect=lambda *a, **k: (_passthrough_opt(1.0, 1.2), risky),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=risky),
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
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            side_effect=lambda project, track, start, end, **k: (
                _passthrough_opt(start, end),
                risky,
            ),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=risky),
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


def test_discourse_like_before_subject_pronoun_kept_despite_low_confidence():
    # Audra on the lab recording: "...interrupt you, like I'm doing again now."
    words = [
        TranscriptWord(text="don't", start=19.96, end=20.12, confidence=1.0),
        TranscriptWord(text="like", start=20.12, end=20.3, confidence=1.0),
        TranscriptWord(text="the", start=20.3, end=20.5, confidence=1.0),
        TranscriptWord(text="you,", start=21.34, end=21.78, confidence=1.0),
        TranscriptWord(text="like", start=21.78, end=22.24, confidence=0.19),
        TranscriptWord(text="I'm", start=22.24, end=22.44, confidence=0.94),
        TranscriptWord(text="doing", start=22.44, end=22.58, confidence=0.99),
    ]
    cands, skips = _collect_with_skips(words, _discourse_defaults(min_filler_cluster=2))
    assert cands == []
    assert skips == {"discourse:like": 2}


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
    from podcast_mcp.services.pipeline.config import merge_pipeline_config

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

    paced = FillerPacingResult(start=0.4, end=2.0)
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
    paced = FillerPacingResult(start=0.4, end=2.0)
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


def test_analyze_rejects_when_max_end_collapses_span():
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
    assert result == _CutRejected("bounds")


def test_analyze_rejects_when_cut_scope_is_skipped():
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
    assert result == _CutRejected("scope")


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


@pytest.mark.parametrize("action", ["track_local", "review"])
def test_analyze_drops_pause_when_peer_speech_forces_track_local(action):
    """A track-local punch never ripples, so it can't shorten the timeline.

    Proposing a ``pause`` cut for review only to have it accomplish nothing
    once approved wastes the reviewer's time; drop it instead (#772).
    """
    from types import SimpleNamespace

    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    project = _project_with_transcript(
        [
            TranscriptWord(text="so", start=1.0, end=1.2),
            TranscriptWord(text="anyway", start=5.0, end=5.3),
        ]
    )
    cand = _CutCandidate(
        track_id="host",
        start=1.2,
        end=5.0,
        reason="pause:3.80s",
        cut_kind="pause",
        max_end=5.0,
    )
    guard = SimpleNamespace(blocked=True, action=action, blocking_track_ids=["guest"])
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        return_value=("track", guard),
    ):
        result = _analyze_candidate(project, cand, {"tighten": {}})
    assert result == _CutRejected("other_speaking")

    # Same candidate with no peer in the way proposes normally (#783): the
    # drop above is specifically the guard forcing a useless track-local
    # punch, not some other reason this candidate can never survive analysis.
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        return_value=("session", None),
    ):
        open_result = _analyze_candidate(project, cand, {"tighten": {}})
    assert open_result is not None
    assert open_result.reason == "pause:3.80s"
    assert open_result.scope == "session"
    assert open_result.start == pytest.approx(1.2)
    assert open_result.end == pytest.approx(5.0)


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


_REJECTIONS = [
    ("apply_filler_pacing", {"return_value": None}, "pacing"),
    ("_cut_span_is_bleed_not_owner", {"return_value": True}, "not_owner"),
    ("assess_cut_risk", {"return_value": CutRisk(score=1.5, reasons=["jump"])}, "risky"),
    ("_clamp_to_candidate", {"return_value": None}, "bounds"),
]
_SCOPE_REJECTION = (
    "speech_energy_guard.resolve_cut_scope",
    {"side_effect": ValueError("no clip")},
    "scope",
)


@pytest.mark.parametrize(
    ("target", "kwargs", "skip", "edit_mode"),
    [
        *((*rejection, mode) for rejection in _REJECTIONS for mode in ("ripple", "mute")),
        # A mute never asks the peers for a scope: it changes only its own track.
        (*_SCOPE_REJECTION, "ripple"),
    ],
)
def test_a_rejected_filler_is_counted_under_its_reason(target, kwargs, skip, edit_mode):
    words = [
        TranscriptWord(text="so", start=0.0, end=0.1),
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="okay.", start=2.0, end=2.3),
    ]
    project = _project_with_transcript(words)
    module = "podcast_mcp.edits" if "." in target else "podcast_mcp.edits.fillers"
    skips: dict[str, int] = {}
    with patch(f"{module}.{target}", **kwargs):
        decisions = analyze_fillers_and_pauses(
            project,
            project.transcripts[0],
            {
                "tighten": {
                    "filler_words": ["uh"],
                    "max_pause_sec": 99.0,
                    "acoustic_gap_filler": {"enabled": False},
                    "edit_mode": edit_mode,
                }
            },
            skip_counts=skips,
        )
    assert (decisions, skips) == ([], {skip: 1})


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
    import numpy as np

    from podcast_mcp.edits.audio_cache import TrackAudioCache
    from podcast_mcp.engines.audio_audit import TrackRmsCache

    silent = TrackRmsCache(np.zeros(16_000 * 3, dtype=np.float32), 16_000)
    sentinel_cache = TrackAudioCache(silent, silent)
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


def _uh_with_overshoot(
    words: list[TranscriptWord], opt_span: tuple[float, float], *, edit_mode: str = "ripple"
):
    """Analyze the lone ``uh`` with waveform optimization moved to ``opt_span``."""
    project = _project_with_transcript(words)
    skips: dict[str, int] = {}
    with patch(
        "podcast_mcp.edits.fillers.optimize_and_assess",
        side_effect=lambda *a, **k: (_passthrough_opt(*opt_span), _safe_risk()),
    ):
        decisions = analyze_fillers_and_pauses(
            project,
            project.transcripts[0],
            {
                "tighten": {
                    "filler_words": ["uh"],
                    "max_pause_sec": 99.0,
                    "acoustic_gap_filler": {"enabled": False},
                    "edit_mode": edit_mode,
                }
            },
            skip_counts=skips,
        )
    return [(d.reason, d.start, d.end, d.replace_gap_sec) for d in decisions], skips


@pytest.mark.parametrize("edit_mode", ["ripple", "mute"])
def test_padded_cut_or_mute_covering_a_whole_kept_word_is_rejected(edit_mode):
    words = [
        TranscriptWord(text="so", start=0.0, end=0.1),
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="we", start=1.22, end=1.4),
        TranscriptWord(text="okay.", start=5.0, end=5.3),
    ]
    assert _uh_with_overshoot(words, (1.0, 1.45), edit_mode=edit_mode) == (
        [],
        {"kept_word:we": 1},
    )


def test_padded_cut_partly_over_a_kept_word_is_proposed():
    words = [
        TranscriptWord(text="so", start=0.0, end=0.1),
        TranscriptWord(text="well", start=0.15, end=0.3),
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="okay.", start=5.0, end=5.3),
    ]
    decisions, skips = _uh_with_overshoot(words, (0.25, 1.2))
    assert decisions == [("filler:uh", 0.25, 1.2, pytest.approx(0.8075))]
    assert skips == {}


@pytest.mark.parametrize("gate", ["breath", "join"])
def test_only_unpadded_cuts_go_through_the_splice_gates(gate):
    from types import SimpleNamespace

    defaults = {
        "tighten": {"filler_words": ["uh"], "max_pause_sec": 99.0, "join_continuity_gate": True}
    }
    unpadded = [
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="okay.", start=2.0, end=2.3),
    ]
    padded = [TranscriptWord(text="so", start=0.0, end=0.1), *unpadded]
    rejecting = {
        "breath": patch("podcast_mcp.edits.fillers.protect_cut_breaths", return_value=None),
        "join": patch(
            "podcast_mcp.edits.join_continuity.assess_proposed_cut",
            return_value=SimpleNamespace(verdict="fail"),
        ),
    }[gate]
    results = {}
    with rejecting:
        for name, words in (("unpadded", unpadded), ("padded", padded)):
            project = _project_with_transcript(words)
            skips: dict[str, int] = {}
            decisions = analyze_fillers_and_pauses(
                project, project.transcripts[0], defaults, skip_counts=skips
            )
            results[name] = (
                [
                    (d.reason, round(d.start, 3), round(d.end, 3), d.replace_gap_sec)
                    for d in decisions
                ],
                skips,
            )
    assert results == {
        "unpadded": (
            [],
            {"acoustic:no_audio": 1, {"breath": "breath", "join": "join_continuity"}[gate]: 1},
        ),
        "padded": ([("filler:uh", 0.14, 1.92, 1.0)], {"acoustic:no_audio": 1}),
    }


_PAUSE_WORDS = [
    TranscriptWord(text="um", start=1.0, end=1.2),
    TranscriptWord(text="okay.", start=1.25, end=1.5),
    TranscriptWord(text="two", start=3.5, end=3.9),
]
_PAUSE_DEFAULTS = {"tighten": {"filler_words": ["um"], "max_pause_sec": 1.2}}


def test_only_a_pause_trim_is_cut_down_to_its_air():
    # A pause trim removes only air, so it shrinks to the air inside it, measured on
    # the pause's own word gap; a filler's edges must stay on the filler (#1055).
    project = _project_with_transcript(_PAUSE_WORDS)
    seen: dict[str, object] = {}

    def air(project, track_id, start, end, **kw):
        seen["pause"] = kw["pause"]
        return (start, end)

    def breaths(project, track_id, start, end, **kw):
        seen["filler"] = (start, end)
        return start, end

    with (
        patch("podcast_mcp.edits.fillers.pause_air_span", side_effect=air),
        patch("podcast_mcp.edits.fillers.protect_cut_breaths", side_effect=breaths),
    ):
        analyze_fillers_and_pauses(project, project.transcripts[0], _PAUSE_DEFAULTS)

    # The pause is the span the trim may take: the word gap less the retained air.
    assert seen == {"pause": (1.5, 2.95), "filler": (1.0, 1.2)}


def test_a_pause_trim_with_no_air_is_skipped_as_no_air():
    project = _project_with_transcript(_PAUSE_WORDS)
    skips: dict[str, int] = {}

    with patch("podcast_mcp.edits.fillers.pause_air_span", return_value=None):
        decisions = analyze_fillers_and_pauses(
            project, project.transcripts[0], _PAUSE_DEFAULTS, skip_counts=skips
        )

    assert [d.reason for d in decisions] == ["filler:um"]
    assert skips == {"acoustic:no_audio": 1, "no_air": 1}


def test_a_pause_trim_whose_edges_moved_off_sound_is_review_only():
    # Until the owner has listened, a trim the air rule shrank is flagged for review;
    # a trim whose edges already sat in air may still apply on its own (#1055).
    def shrink(project, track_id, start, end, **kw):
        return (start + 0.1, end)

    def pause_of(decisions):
        hit = next(d for d in decisions if d.reason.startswith("pause:"))
        return hit.reason, hit.review_required

    project = _project_with_transcript(_PAUSE_WORDS)
    with patch("podcast_mcp.edits.fillers.pause_air_span", side_effect=shrink):
        moved = analyze_fillers_and_pauses(project, project.transcripts[0], _PAUSE_DEFAULTS)
    project = _project_with_transcript(_PAUSE_WORDS)
    kept = analyze_fillers_and_pauses(project, project.transcripts[0], _PAUSE_DEFAULTS)

    assert pause_of(moved) == ("pause:2.00s:solo:air_edges", True)
    assert pause_of(kept) == ("pause:2.00s:solo", False)


def test_a_mute_fades_each_edge_against_fill_so_the_join_gate_skips_it():
    from types import SimpleNamespace

    defaults = {
        "tighten": {
            "filler_words": ["uh"],
            "max_pause_sec": 99.0,
            "join_continuity_gate": True,
            "edit_mode": "mute",
        }
    }
    words = [
        TranscriptWord(text="so", start=0.0, end=0.1),
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="okay.", start=2.0, end=2.3),
    ]
    project = _project_with_transcript(words)
    with patch(
        "podcast_mcp.edits.join_continuity.assess_proposed_cut",
        return_value=SimpleNamespace(verdict="fail"),
    ):
        decisions = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)

    assert [
        (d.type.value, d.reason, round(d.start, 3), round(d.end, 3), d.replace_gap_sec, d.scope)
        for d in decisions
    ] == [("mute", "filler:uh", 0.14, 1.92, None, "track")]


def _write_wav(path, segments: list[tuple[float, object]], *, rate: int = 16_000) -> None:
    """Room noise at -95 dB, 4 s long, with each ``(start_sec, samples)`` added on top."""
    import wave

    import numpy as np

    samples = np.random.default_rng(7).standard_normal(4 * rate) * 10 ** (-95 / 20)
    for start, segment in segments:
        i = round(start * rate)
        samples[i : i + len(segment)] += segment
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())


def _voice(sec: float, *, level_db: float = -20.0, rate: int = 16_000):
    import numpy as np

    t = np.arange(round(sec * rate)) / rate
    tone = sum(np.sin(2 * np.pi * 150.0 * k * t) / k for k in range(1, 6))
    return tone / np.sqrt(np.mean(tone**2)) * 10 ** (level_db / 20)


def _audio_project(
    tmp_path, segments, words: list[TranscriptWord], *, rate: int = 16_000
) -> EpisodeProject:
    ws = tmp_path / "ws"
    _write_wav(ws / "raw" / "host.wav", segments, rate=rate)
    project = EpisodeProject.create("padded", str(ws))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0)
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    return project


def test_audio_padded_filler_with_edges_in_activity_is_proposed(tmp_path):
    import numpy as np

    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    # Room tone 35 dB over the floor joins the um's onset and tail into one run that
    # is too long to be a breath, as on the lab tape (#978).
    bed = np.random.default_rng(1).standard_normal(round(1.6 * 16_000)) * 10 ** (-60 / 20)
    project = _audio_project(
        tmp_path,
        [(0.3, _voice(0.3)), (0.6, bed), (1.2, _voice(0.4)), (2.4, _voice(0.4))],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="um,", start=1.2, end=1.6, confidence=0.9),
            TranscriptWord(text="okay.", start=2.4, end=2.8, confidence=0.95),
        ],
    )
    defaults = load_defaults()

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)

    assert (decision.reason, decision.review_required, decision.replace_gap_sec) == (
        "filler:um",
        False,
        1.0,
    )
    assert (decision.start, decision.end) == pytest.approx((0.64, 2.32), abs=0.005)
    assert (
        protect_cut_breaths(project, "host", decision.start, decision.end, defaults=defaults)
        is None
    )


def test_audio_padded_filler_cut_ends_before_a_plosive_burst(tmp_path):
    import numpy as np

    from podcast_mcp.config import load_defaults

    noise = np.random.default_rng(3).standard_normal(round(0.1 * 16_000))
    burst = noise[: round(0.008 * 16_000)] * 10 ** (-50 / 20)
    aspiration = noise * 10 ** (-48 / 20)
    project = _audio_project(
        tmp_path,
        [
            (0.3, _voice(0.3)),
            (1.0, _voice(0.3)),
            (1.42, burst),
            (1.43, aspiration),
            (1.53, _voice(0.3, level_db=-18)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
            # A late word time: "pat" bursts at 1.42 s and voices at 1.53 s, after
            # 100 ms of aspiration a voiced-edge nudge would cut.
            TranscriptWord(text="pat.", start=1.7, end=1.9, confidence=0.95),
        ],
    )

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], load_defaults())

    assert (decision.reason, decision.replace_gap_sec) == ("filler:uh", pytest.approx(0.935))
    assert decision.end == pytest.approx(1.40)


def test_audio_mute_ends_before_a_plosive_burst_and_carries_it(tmp_path):
    import numpy as np

    from podcast_mcp.config import load_defaults

    noise = np.random.default_rng(3).standard_normal(round(0.1 * 16_000))
    project = _audio_project(
        tmp_path,
        [
            (0.3, _voice(0.3)),
            (1.0, _voice(0.3)),
            (1.42, noise[: round(0.008 * 16_000)] * 10 ** (-50 / 20)),
            (1.43, noise * 10 ** (-48 / 20)),
            (1.53, _voice(0.3, level_db=-18)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
            TranscriptWord(text="pat.", start=1.7, end=1.9, confidence=0.95),
        ],
    )
    defaults = load_defaults()
    defaults["tighten"]["edit_mode"] = "mute"

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)

    # The mute fades back in after the cut like a padded cut, so approval ends that
    # fade-in before the burst.
    assert (decision.type.value, decision.reason, decision.replace_gap_sec) == (
        "mute",
        "filler:uh",
        None,
    )
    assert decision.end == pytest.approx(1.40)
    assert decision.next_burst_sec == pytest.approx(1.41)


@pytest.mark.parametrize(
    ("level_db", "proposed", "skips"),
    [
        (-20.0, [("mute", "filler:acoustic", 1.48, 1.915)], {"acoustic:voiced_edge": 1}),
        (-50.0, [], {"acoustic:voiced_edge": 1, "acoustic:inaudible": 1}),
    ],
)
def test_audio_mute_proposes_only_audible_acoustic_runs_apart_from_kept_words(
    tmp_path, level_db, proposed, skips
):
    from podcast_mcp.config import load_defaults

    project = _audio_project(
        tmp_path,
        [
            # "So" runs on, voiced, 300 ms past its word time: the run in the gap
            # after it is the word's own sound.
            (0.3, _voice(0.6)),
            (1.5, _voice(0.4, level_db=level_db)),
            (2.6, _voice(0.4)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="okay.", start=2.6, end=3.0, confidence=0.95),
        ],
    )
    defaults = load_defaults()
    defaults["tighten"]["edit_mode"] = "mute"
    found: dict[str, int] = {}

    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], defaults, skip_counts=found
    )

    assert [(d.type.value, d.reason, round(d.start, 3), round(d.end, 3)) for d in decisions] == (
        proposed
    )
    assert found == skips


def test_audio_mute_is_the_same_whoever_else_is_talking(tmp_path):
    from podcast_mcp.config import load_defaults

    def proposal(*, guest_talking: bool):
        project = _audio_project(
            tmp_path / str(guest_talking),
            [(0.3, _voice(0.3)), (1.0, _voice(0.3)), (2.4, _voice(0.4))],
            [
                TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
                TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
                TranscriptWord(text="okay.", start=2.4, end=2.8, confidence=0.95),
            ],
        )
        ws = tmp_path / str(guest_talking) / "ws"
        _write_wav(ws / "raw" / "guest.wav", [(0.7, _voice(1.5, level_db=-18))])
        project.tracks.append(
            Track(
                id="guest",
                label="Guest",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/guest.wav", duration_sec=4.0),
            )
        )
        project.clips.append(
            Clip(id="c2", track_id="guest", source_start=0.0, source_end=4.0, timeline_start=0.0)
        )
        guest_words = [
            TranscriptWord(text="well", start=0.7, end=1.4, confidence=0.9),
            TranscriptWord(text="then", start=1.5, end=2.2, confidence=0.9),
        ]
        project.transcripts.append(
            Transcript(track_id="guest", words=guest_words if guest_talking else [])
        )
        if not guest_talking:
            _write_wav(ws / "raw" / "guest.wav", [])
        defaults = load_defaults()
        defaults["tighten"]["edit_mode"] = "mute"
        defaults["tighten"]["acoustic_gap_filler"] = {"enabled": False}
        return [
            (d.type.value, d.reason, d.review_required, d.scope, round(d.start, 3), round(d.end, 3))
            for d in analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
        ]

    expected = [("mute", "filler:uh", False, "track", 0.64, 2.32)]
    assert proposal(guest_talking=True) == expected
    assert proposal(guest_talking=False) == expected


@pytest.mark.parametrize("edit_mode", ["ripple", "mute"])
def test_audio_cut_that_would_stop_inside_the_filler_is_dropped_as_next_onset(tmp_path, edit_mode):
    import numpy as np

    from podcast_mcp.config import load_defaults

    noise = np.random.default_rng(3).standard_normal(round(0.1 * 16_000))
    project = _audio_project(
        tmp_path,
        [
            (0.3, _voice(0.3)),
            (1.0, _voice(0.3)),
            (1.33, noise[: round(0.008 * 16_000)] * 10 ** (-50 / 20)),
            (1.34, noise * 10 ** (-48 / 20)),
            (1.44, _voice(0.3, level_db=-26)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            # Whisper ran the filler 100 ms late, over the next word's burst at 1.33 s.
            TranscriptWord(text="uh,", start=1.0, end=1.4, confidence=0.9),
            TranscriptWord(text="pat.", start=1.7, end=1.9, confidence=0.95),
        ],
    )
    defaults = load_defaults()
    defaults["tighten"]["edit_mode"] = edit_mode
    defaults["tighten"]["acoustic_gap_filler"] = {"enabled": False}
    skips: dict[str, int] = {}

    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], defaults, skip_counts=skips
    )

    assert decisions == []
    assert skips == {"next_onset": 1}


def test_approved_padded_cut_leaves_the_plosive_burst_unattenuated(tmp_path):
    import wave

    import numpy as np

    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.decisions import approve_edits
    from podcast_mcp.engines.play_audit import premix_path
    from podcast_mcp.render import rerender_preview

    rate = 48_000
    noise = np.random.default_rng(3).standard_normal(round(0.05 * rate))
    burst = noise[: round(0.008 * rate)] * 10 ** (-50 / 20)
    aspiration = noise * 10 ** (-48 / 20)
    burst_at = 1.42
    project = _audio_project(
        tmp_path,
        [
            (0.3, _voice(0.3, rate=rate)),
            (1.0, _voice(0.3, rate=rate)),
            (burst_at, burst),
            (burst_at + 0.01, aspiration),
            # A hot vowel inside the look-ahead: the recommended fade-in is the full
            # 120 ms ramp, which would start at the cut end and still be rising at the burst.
            (1.46, _voice(0.3, level_db=-18, rate=rate)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
            TranscriptWord(text="pat.", start=1.7, end=1.9, confidence=0.95),
        ],
        rate=rate,
    )

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], load_defaults())
    assert decision.replace_gap_sec
    assert decision.end < burst_at
    assert decision.next_burst_sec == pytest.approx(decision.end + 0.01)
    project.edit_decisions = [decision]
    assert approve_edits(project, [decision.id]) == 1
    rerender_preview(project, reconcile=False)

    def pcm(path) -> np.ndarray:
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            data = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
        return data.reshape(-1, channels)[:, 0].astype(int)

    source = pcm(project.workspace_path() / "raw" / "host.wav")
    rendered = pcm(premix_path(project))
    first, last = round(burst_at * rate), round((burst_at + 0.02) * rate)
    # The pad replaces the cut: everything the render keeps after it shifts by the pad.
    shift = round((decision.replace_gap_sec - (decision.end - decision.start)) * rate)
    assert np.abs(rendered[first + shift : last + shift] - source[first:last]).max() <= 1


@pytest.mark.parametrize("burst_at", [1.50, 1.56])
def test_onset_past_the_cut_end_still_caps_the_post_pad_fade_in(tmp_path, burst_at):
    import numpy as np

    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms
    from podcast_mcp.edits.decisions import approve_edits

    rate = 48_000
    noise = np.random.default_rng(3).standard_normal(round(0.05 * rate))
    project = _audio_project(
        tmp_path,
        [
            (0.3, _voice(0.3, rate=rate)),
            (1.0, _voice(0.3, rate=rate)),
            (burst_at, noise[: round(0.008 * rate)] * 10 ** (-50 / 20)),
            (burst_at + 0.01, noise * 10 ** (-48 / 20)),
            (burst_at + 0.04, _voice(0.3, level_db=-18, rate=rate)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
            # Timed at its voicing, so pacing ends the cut short of the burst, outside
            # the onset guard (the lab's "uh, nope" at 604.80).
            TranscriptWord(text="pat.", start=burst_at + 0.04, end=burst_at + 0.3, confidence=0.95),
        ],
        rate=rate,
    )
    defaults = load_defaults()

    decisions = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    (decision,) = [d for d in decisions if d.reason == "filler:uh"]

    assert decision.next_burst_sec == pytest.approx(burst_at, abs=0.011)
    assert decision.next_burst_sec - decision.end > 0.02
    headroom_ms = (decision.next_burst_sec - decision.end) * 1000.0
    project.edit_decisions = [decision]
    assert approve_edits(project, [decision.id]) == 1
    resumed = next(c for c in project.clips if c.source_start >= decision.end - 1e-6)
    assert resumed.fade_in_ms <= headroom_ms + 1e-6
    assert recommend_post_pad_fade_in_ms(project, "host", decision.end, defaults=defaults) > (
        headroom_ms
    )


def test_gradual_onset_after_a_padded_cut_keeps_the_full_post_pad_fade_in(tmp_path):
    import numpy as np

    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms
    from podcast_mcp.edits.decisions import approve_edits

    rate = 48_000
    # "she": the high band climbs about 4 dB per 10 ms from the room, then holds.
    ramp_n = round(0.15 * rate)
    ramp = np.random.default_rng(5).standard_normal(ramp_n) * np.power(
        10.0, np.linspace(-90.0, -30.0, ramp_n) / 20.0
    )
    hold = np.random.default_rng(6).standard_normal(round(0.2 * rate)) * 10 ** (-28 / 20)
    project = _audio_project(
        tmp_path,
        [
            (0.3, _voice(0.3, rate=rate)),
            (1.0, _voice(0.3, rate=rate)),
            (1.40, ramp),
            (1.55, hold),
            (1.8, _voice(0.3, level_db=-18, rate=rate)),
        ],
        [
            TranscriptWord(text="So", start=0.3, end=0.6, confidence=0.95),
            TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
            TranscriptWord(text="she", start=1.5, end=1.9, confidence=0.95),
        ],
        rate=rate,
    )
    defaults = load_defaults()

    decisions = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    (decision,) = [d for d in decisions if d.reason == "filler:uh"]

    assert decision.replace_gap_sec
    assert decision.next_burst_sec is None
    recommended = recommend_post_pad_fade_in_ms(project, "host", decision.end, defaults=defaults)
    assert recommended > 40
    project.edit_decisions = [decision]
    assert approve_edits(project, [decision.id]) == 1
    resumed = next(c for c in project.clips if c.source_start >= decision.end - 1e-6)
    assert resumed.fade_in_ms == recommended


def _late_filler_defaults(join: str) -> dict:
    from podcast_mcp.config import load_defaults

    defaults = load_defaults()
    defaults["tighten"]["filler_room_tone_replace"] = join == "padded"
    # The fillers alone: the word gaps after them are not pause hits.
    defaults["tighten"]["max_pause_sec"] = 99.0
    return defaults


@pytest.mark.parametrize("join", ["padded", "splice"])
@pytest.mark.parametrize(
    ("word_start", "cut_start"),
    [
        # The "um" voices from 0.90 s; the aligner starts it 300 ms late (lab 616.26
        # and 713.00, #1061).
        (1.2, 0.88),
        # A word start on the voice onset keeps its edge.
        (0.9, 0.90),
    ],
)
def test_filler_cut_starts_before_the_voice_an_aligner_timed_late(
    tmp_path, join, word_start, cut_start
):
    project = _audio_project(
        tmp_path,
        [(0.2, _voice(0.3)), (0.9, _voice(0.4)), (3.4, _voice(0.3))],
        [
            TranscriptWord(text="So", start=0.2, end=0.5, confidence=0.95),
            TranscriptWord(text="um,", start=word_start, end=1.3, confidence=0.9),
            TranscriptWord(text="okay.", start=3.4, end=3.7, confidence=0.95),
        ],
    )

    (decision,) = analyze_fillers_and_pauses(
        project, project.transcripts[0], _late_filler_defaults(join)
    )

    assert (decision.reason, decision.review_required) == ("filler:um", False)
    assert decision.start == pytest.approx(cut_start, abs=0.005)


@pytest.mark.parametrize("join", ["padded", "splice"])
def test_filler_whose_voice_runs_on_from_a_kept_word_is_skipped(tmp_path, join):
    project = _audio_project(
        tmp_path,
        # "So" runs straight into the "uh" with no quiet between (lab "to like" at 424.6).
        [(0.2, _voice(1.1)), (3.4, _voice(0.3))],
        [
            TranscriptWord(text="So", start=0.2, end=0.8, confidence=0.95),
            TranscriptWord(text="uh,", start=1.0, end=1.3, confidence=0.9),
            TranscriptWord(text="okay.", start=3.4, end=3.7, confidence=0.95),
        ],
    )
    skips: dict[str, int] = {}

    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], _late_filler_defaults(join), skip_counts=skips
    )

    assert [d.reason for d in decisions] == []
    assert skips == {"filler_onset": 1}


@pytest.mark.parametrize(
    ("word_start", "cut"),
    [
        # The aligner starts the "um" 600 ms into its voice: pacing sees a 0.1 s word,
        # and the onset walk-back widens the cut to the voice (lab 616.26, #1074).
        (1.2, (0.58, 1.3, 0.612)),
        # A word start on the voice onset: nothing widens.
        (0.6, (0.6, 1.3, 0.595)),
    ],
)
def test_filler_pad_is_paced_from_the_span_the_cut_removes(tmp_path, word_start, cut):
    project = _audio_project(
        tmp_path,
        [(0.2, _voice(0.3)), (0.6, _voice(0.7)), (3.4, _voice(0.3))],
        [
            TranscriptWord(text="So", start=0.2, end=0.5, confidence=0.95),
            TranscriptWord(text="um,", start=word_start, end=1.3, confidence=0.9),
            TranscriptWord(text="okay.", start=3.4, end=3.7, confidence=0.95),
        ],
    )

    (decision,) = analyze_fillers_and_pauses(
        project, project.transcripts[0], _late_filler_defaults("padded")
    )

    # clamp(0.35, 0.85 x span, 1.0) of the span shipped, wherever the word time sat.
    assert (decision.start, decision.end, decision.replace_gap_sec) == pytest.approx(cut, abs=0.002)


def test_cut_plan_paces_its_pad_from_its_own_span():
    from dataclasses import replace

    from podcast_mcp.edits.filler_pacing import PacedPad
    from podcast_mcp.edits.fillers import _CutPlan, _Join

    pad = PacedPad(gap_sec=0.0, min_sec=0.35, retain=0.85, max_sec=1.0)
    plan = _CutPlan.for_cut(1.2, 1.3, mute=False, scope="session", pad=pad)

    assert (plan.join, plan.replace_gap_sec) == (_Join.PADDED, pytest.approx(0.35))
    # An edge check that moves the left edge to the voice resizes the pad with it.
    assert replace(plan, start=0.5).replace_gap_sec == pytest.approx(0.68)
    # Air the cut took whole still sets the floor when the span shrinks inside it.
    gap_plan = _CutPlan.for_cut(
        1.0, 2.0, mute=False, scope="session", pad=replace(pad, gap_sec=1.1)
    )
    assert replace(gap_plan, end=1.5).replace_gap_sec == pytest.approx(0.935)
    # A track punch and a mute keep their time, so they insert no pad.
    punch = _CutPlan.for_cut(1.2, 1.3, mute=False, scope="track", pad=pad)
    mute = _CutPlan.for_cut(1.2, 1.3, mute=True, scope="session", pad=pad)
    assert (punch.join, punch.replace_gap_sec) == (_Join.SPLICE, None)
    assert (mute.join, mute.replace_gap_sec) == (_Join.MUTE, None)


def _scope_result(scope: str):
    from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult

    if scope == "track":
        return "track", SpeechEnergyGuardResult(blocking_track_ids=("guest",), action="track_local")
    return "session", SpeechEnergyGuardResult(blocking_track_ids=(), action=None)


def _analyze_with_scope_flip(first: str, then: str, *, join_verdict: str):
    """Analyze the padded ``uh`` while the scope resolves to ``first`` once, then ``then``."""
    from types import SimpleNamespace

    scopes = iter([first])
    words = [
        TranscriptWord(text="so", start=0.0, end=0.1),
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="okay.", start=2.0, end=2.3),
    ]
    project = _project_with_transcript(words)
    defaults = {
        "tighten": {"filler_words": ["uh"], "max_pause_sec": 99.0, "join_continuity_gate": True}
    }
    with (
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            side_effect=lambda *_a, **_k: _scope_result(next(scopes, then)),
        ),
        patch(
            "podcast_mcp.edits.join_continuity.assess_proposed_cut",
            return_value=SimpleNamespace(verdict=join_verdict),
        ),
    ):
        return [
            (d.scope, d.replace_gap_sec, d.reason)
            for d in analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
        ]


def test_a_scope_that_flips_to_a_track_punch_gets_the_splice_gates_and_no_pad():
    # The punch ships a butt splice, so the join gate scores it: pass keeps the punch
    # with no pad, fail rejects it. The padded plan's gate skip never carries over.
    assert _analyze_with_scope_flip("session", "track", join_verdict="pass") == [
        ("track", None, "filler:uh:track_local:guest")
    ]
    assert _analyze_with_scope_flip("session", "track", join_verdict="fail") == []


def test_a_scope_that_flips_to_a_session_cut_keeps_its_pad_and_skips_the_splice_gates():
    # The session cut ships two faded edges, so the failing join verdict is never
    # asked and the pad survives.
    assert _analyze_with_scope_flip("track", "session", join_verdict="fail") == [
        ("session", 1.0, "filler:uh")
    ]


def test_a_scope_that_never_settles_is_not_proposed():
    flip = iter(["session", "track", "session", "track"])
    words = [
        TranscriptWord(text="so", start=0.0, end=0.1),
        TranscriptWord(text="uh", start=1.0, end=1.2),
        TranscriptWord(text="okay.", start=2.0, end=2.3),
    ]
    project = _project_with_transcript(words)
    skips: dict[str, int] = {}
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        side_effect=lambda *_a, **_k: _scope_result(next(flip)),
    ):
        assert not analyze_fillers_and_pauses(
            project,
            project.transcripts[0],
            {
                "tighten": {
                    "filler_words": ["uh"],
                    "max_pause_sec": 99.0,
                    "acoustic_gap_filler": {"enabled": False},
                }
            },
            skip_counts=skips,
        )
    assert skips == {"unstable_scope": 1}
