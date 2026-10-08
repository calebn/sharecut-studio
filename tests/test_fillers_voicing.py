"""Tier A pins for voiced speech at tighten cut edges and inside pause spans (#815, #818).

Synthetic tracks: a 180 Hz harmonic "vowel" for voice, digital silence (-200 dBFS,
Zoom's gate) between words. Breath handling is disabled because these fixtures
have no measurable room-tone contrast; complete breath protection has its own tests. Word times are what the transcript says; the audio is
what the listener hears, and the two disagree on purpose where the issues did.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.fillers import (
    _check_voiced_speech,
    _CutCandidate,
    analyze_fillers_and_pauses,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.tighten import apply_tighten_decisions, propose_tighten_edits
from podcast_mcp.edits.voiced_runs import run_straddling, voiced_runs, voiced_sec_inside
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.gui.assembler import build_project_view
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import CommentService

RATE = 16_000
DEFAULTS: dict[str, object] = {
    "tighten": {"breath_handling": {"enabled": False}, "max_pause_sec": 1.2}
}
# The word tail past its transcript time is itself a review-only acoustic candidate;
# the edge pins look at the pause alone.
EDGE_DEFAULTS: dict[str, object] = {
    "tighten": {
        "breath_handling": {"enabled": False},
        "max_pause_sec": 1.2,
        "acoustic_gap_filler": {"enabled": False},
    }
}


def _voice(samples: np.ndarray, start: float, end: float, *, level_db: float = -20.0) -> None:
    n = int((end - start) * RATE)
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * 180.0 * k * t) / k for k in range(1, 6))
    tone = tone / np.sqrt(np.mean(tone**2)) * 10 ** (level_db / 20)
    samples[int(start * RATE) : int(start * RATE) + n] = tone.astype(np.float32)


def _breath(samples: np.ndarray, start: float, end: float, *, level_db: float = -30.0) -> None:
    n = int((end - start) * RATE)
    noise = np.random.default_rng(3).normal(0, 1.0, n)
    noise = noise / np.sqrt(np.mean(noise**2)) * 10 ** (level_db / 20)
    samples[int(start * RATE) : int(start * RATE) + n] = noise.astype(np.float32)


def _cache(samples: np.ndarray) -> TrackAudioCache:
    empty = TrackRmsCache(np.zeros(1, dtype=np.float32), RATE)
    return TrackAudioCache(empty, TrackRmsCache(samples.astype(np.float32), RATE))


def _project(
    tmp_path: Path,
    samples: np.ndarray,
    words: list[TranscriptWord],
    *,
    peer: np.ndarray | None = None,
) -> EpisodeProject:
    """One dialogue track "host"; with ``peer``, a second one "guest" with no words."""
    project = EpisodeProject.create("voicing", str(tmp_path))
    for tid, audio in (("host", samples), ("guest", peer)):
        if audio is None:
            continue
        path = tmp_path / "raw" / f"{tid}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(RATE)
            handle.writeframes((np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes())
        duration = audio.size / RATE
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=duration),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=duration,
                timeline_start=0.0,
            )
        )
        project.transcripts.append(Transcript(track_id=tid, words=words if tid == "host" else []))
    return project


def test_voiced_runs_quantize_to_the_frame_grid_and_skip_breath() -> None:
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 1.25)
    _breath(samples, 2.0, 2.3)
    runs = voiced_runs(_cache(samples).waveform, 0.0, 4.0, floor_db=-42.0)
    assert runs == [(pytest.approx(0.19), pytest.approx(1.26))]
    assert run_straddling(runs, 1.0) == runs[0]
    assert run_straddling(runs, 1.25) is None
    assert run_straddling(runs, 0.2) is None
    assert voiced_sec_inside(runs, 1.0, 3.0) == pytest.approx(0.26)
    assert voiced_sec_inside(runs, 2.0, 3.0) == 0.0


def test_voiced_runs_ignore_the_window_placement_and_digital_silence() -> None:
    samples = np.zeros(3 * RATE, dtype=np.float32)
    _voice(samples, 1.0, 1.5)
    cache = _cache(samples).waveform
    assert voiced_runs(cache, 0.937, 2.2, floor_db=-42.0) == voiced_runs(
        cache, 0.5, 3.0, floor_db=-42.0
    )
    assert voiced_runs(cache, 1.6, 3.0, floor_db=-42.0) == []


def test_kept_word_overlaps_excludes_the_cut_word() -> None:
    project = EpisodeProject.create("idx", "/tmp/ws")
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="of", start=16.34, end=16.38),
                TranscriptWord(text="like", start=16.52, end=16.70),
                TranscriptWord(text="edits", start=17.30, end=17.58),
                TranscriptWord(text="muted", start=16.9, end=17.1, suppressed=True),
            ],
        )
    ]
    index = CutWordIndex.build(project, "host")
    # The voice before the edge is "like" itself, not a word that stays.
    assert not index.kept_word_overlaps(16.50, 16.63, exclude_start=16.52, exclude_end=17.22)
    # ... unless the run reaches back into "of".
    assert index.kept_word_overlaps(15.83, 16.63, exclude_start=16.52, exclude_end=17.22)
    assert index.kept_word_overlaps(17.22, 17.40, exclude_start=16.52, exclude_end=17.22)
    assert not index.kept_word_overlaps(16.9, 17.1, exclude_start=16.52, exclude_end=16.70)


def test_speech_inside_an_asr_gap_never_becomes_an_auto_applicable_pause(tmp_path: Path) -> None:
    """#818: Whisper dropped a sentence between "one" and "two"; the gap is still speech."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 0.4)
    _voice(samples, 0.6, 2.4)
    _voice(samples, 3.0, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, samples, words)

    proposal = propose_tighten_edits(project, DEFAULTS)

    (decision,) = proposal.decisions
    assert decision.reason == "pause:2.60s:solo:interior_speech"
    assert decision.review_required is True
    assert (decision.start, decision.end) == (pytest.approx(0.4, abs=0.05), pytest.approx(2.45))
    assert apply_tighten_decisions(project) == 0


def test_pause_start_inside_a_word_tail_moves_past_the_voice(tmp_path: Path) -> None:
    """#815: the aligner ends "one" at 1.0 s but the vowel runs to 1.25 s."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 1.25)
    _voice(samples, 3.0, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=1.0),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, samples, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.00s:solo:air_edges"
    assert decision.review_required is False
    # Voice edge on the frame grid (1.26) plus 60 ms of air.
    assert decision.start == pytest.approx(1.32, abs=0.011)
    assert decision.end == pytest.approx(2.45)


def test_pause_end_inside_the_next_word_onset_moves_before_the_voice(tmp_path: Path) -> None:
    """Whisper hears "two" start at 3.0 s; the voice starts at 2.3 s, inside the cut."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 0.4)
    _voice(samples, 2.3, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, samples, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.60s:solo:air_edges"
    assert decision.review_required is False
    assert decision.start == pytest.approx(0.4, abs=0.05)
    # Voice edge on the frame grid (2.29) minus 60 ms of air.
    assert decision.end == pytest.approx(2.23, abs=0.011)


def test_clean_dead_air_is_proposed_to_apply_and_applies_with_the_fillers(tmp_path: Path) -> None:
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 0.58)
    _voice(samples, 3.0, 3.4)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.6),
        TranscriptWord(text="two", start=3.0, end=3.4),
    ]
    project = _project(tmp_path, samples, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], DEFAULTS)

    # Dead air passes the checks a filler passes (#1055): it needs no review and applies
    # with the auto-tighten edits.
    assert decision.reason == "pause:2.40s:solo"
    assert decision.review_required is False
    assert 0.58 <= decision.start <= 0.62
    assert decision.end == pytest.approx(2.45)
    assert apply_tighten_decisions(project) == 1
    assert project.edit_decisions == []


CONTINUOUS_VOICE_DEFAULTS: dict[str, object] = {
    "tighten": {
        "breath_handling": {"enabled": False},
        "filler_words": ["like", "um"],
        "discourse_markers": [],
    }
}


def _continuous_voice_project(tmp_path: Path) -> EpisodeProject:
    """Continuous "kind of like um edits": neither edge of a filler cut can leave the voice."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.5, 2.2)
    _voice(samples, 2.3, 2.6)
    words = [
        TranscriptWord(text="kind", start=0.5, end=0.9),
        TranscriptWord(text="of", start=0.95, end=1.1),
        TranscriptWord(text="like", start=1.2, end=1.5),
        TranscriptWord(text="um", start=1.55, end=1.8),
        TranscriptWord(text="edits", start=2.3, end=2.6),
    ]
    return _project(tmp_path, samples, words)


def test_filler_with_voice_running_on_from_the_kept_word_before_is_skipped(
    tmp_path: Path,
) -> None:
    project = _continuous_voice_project(tmp_path)
    skips: dict[str, int] = {}

    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], CONTINUOUS_VOICE_DEFAULTS, skip_counts=skips
    )

    # Neither "like" nor "um" starts out of quiet after the kept word before it (#1061).
    assert [d.reason for d in decisions] == []
    assert skips == {"filler_onset": 2}


def _fused_voice_project(tmp_path: Path) -> EpisodeProject:
    """ "kind of ... um edits": the "um" runs straight into the kept "edits"."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.5, 1.1)
    _voice(samples, 1.5, 2.2)
    words = [
        TranscriptWord(text="kind", start=0.5, end=0.9),
        TranscriptWord(text="of", start=0.95, end=1.1),
        TranscriptWord(text="um", start=1.55, end=1.8),
        TranscriptWord(text="edits", start=1.85, end=2.2),
    ]
    return _project(tmp_path, samples, words)


def test_filler_cut_ending_in_a_kept_word_voice_is_reviewed(tmp_path: Path) -> None:
    project = _fused_voice_project(tmp_path)

    decisions = analyze_fillers_and_pauses(
        project, project.transcripts[0], CONTINUOUS_VOICE_DEFAULTS
    )

    assert [(d.reason, d.review_required) for d in decisions] == [("filler:um:voiced_edge", True)]


def test_reproposal_regenerates_its_own_review_flagged_hits(tmp_path: Path) -> None:
    """Find hits on an unchanged project converges (#995): a generated review flag
    such as ``voiced_edge`` is not ownership, so re-proposal replaces that pending
    hit and reports it again instead of keeping the stale copy and dropping it."""
    project = _fused_voice_project(tmp_path)

    runs = []
    for _ in range(3):
        proposal = propose_tighten_edits(project, CONTINUOUS_VOICE_DEFAULTS)
        hits = [
            (d.id, d.track_id, d.start, d.end, d.reason, d.review_required)
            for d in proposal.decisions
        ]
        pending = [
            (d.id, d.track_id, d.start, d.end, d.reason, d.review_required)
            for d in project.edit_decisions
        ]
        runs.append((hits, pending, proposal.skip_counts))

    assert [hit[4:] for hit in runs[0][0]] == [("filler:um:voiced_edge", True)]
    assert runs[0][1] == runs[0][0]
    assert runs[1] == runs[0]
    assert runs[2] == runs[0]


FILLER_AND_PAUSE_DEFAULTS: dict[str, object] = {
    "tighten": {
        "breath_handling": {"enabled": False},
        "max_pause_sec": 1.2,
        "filler_words": ["um"],
        "discourse_markers": [],
    }
}


def _filler_and_pause_project(tmp_path: Path, *, peer: bool = False) -> EpisodeProject:
    """ "one um two ... three": a clean ``um`` hit and a 2 s pause hit on "host" (and,
    with ``peer``, the same words and audio on "guest")."""
    spans = [(0.2, 0.6), (1.0, 1.3), (1.6, 2.0), (4.0, 4.4)]
    samples = np.zeros(6 * RATE, dtype=np.float32)
    for start, end in spans:
        _voice(samples, start, end)
    words = [
        TranscriptWord(text=text, start=start, end=end)
        for text, (start, end) in zip(["one", "um", "two", "three"], spans, strict=True)
    ]
    project = _project(tmp_path, samples, words, peer=samples if peer else None)
    if peer:
        project.transcripts[1].words = [w.model_copy() for w in words]
    return project


def test_reproposal_keeps_an_ask_thread_on_its_hit(tmp_path: Path) -> None:
    """#999: an Ask thread links to a pending hit by id, so Find hits again on an
    unchanged project must hand the same hit the same id."""
    ws = ProjectWorkspace.open(save_project(_filler_and_pause_project(tmp_path)))

    def find_hits() -> list[EditDecision]:
        return ws.mutate(
            "before propose edits",
            "after propose edits",
            lambda p: propose_tighten_edits(p, FILLER_AND_PAUSE_DEFAULTS).decisions,
        )

    first = find_hits()
    pause = next(d for d in first if d.reason.startswith("pause:"))
    thread = CommentService(ws).add(
        body="Does this pause land too fast?",
        author="guest",
        timeline_start=pause.start,
        edit_decision_id=pause.id,
    )

    second = find_hits()

    assert [(d.id, d.start, d.end, d.reason) for d in second] == [
        (d.id, d.start, d.end, d.reason) for d in first
    ]
    view = build_project_view(ws)
    (attached,) = [row for row in view.pending_edits if row["id"] == thread["edit_decision_id"]]
    assert (attached["reason"], attached["source_start"], attached["source_end"]) == (
        "pause:2.00s:solo",
        2.0,
        3.45,
    )
    assert [c["edit_decision_id"] for c in view.comments] == [attached["id"]]
    with pytest.raises(ValueError, match="already has a comment thread"):
        CommentService(ws).add(
            body="second root", author="host", timeline_start=2.0, edit_decision_id=pause.id
        )


def test_a_pause_hit_keeps_its_id_when_intensity_moves_its_end(tmp_path: Path) -> None:
    """The pause is its word gap; the retain floor only decides where the trim ends."""
    project = _filler_and_pause_project(tmp_path)

    pauses = [
        next(
            (d.id, d.start, d.end)
            for d in propose_tighten_edits(
                project, FILLER_AND_PAUSE_DEFAULTS, intensity=level
            ).decisions
            if d.reason.startswith("pause:")
        )
        for level in ("light", "medium", "aggressive")
    ]

    assert [end for _id, _start, end in pauses] == pytest.approx([3.25, 3.45, 3.66])
    assert len({hit_id for hit_id, _start, _end in pauses}) == 1


def test_distinct_hits_never_share_an_id(tmp_path: Path) -> None:
    """Two tracks with the same words and audio: the same filler at the same source span
    on each track is still two hits. A session pause trim is one hit, though: both tracks
    are quiet over the same stretch and a ripple removes it from both, so it is proposed
    once (the host's) and the guest's copy is dropped as ``shared_pause``."""
    project = _filler_and_pause_project(tmp_path, peer=True)

    proposal = propose_tighten_edits(project, FILLER_AND_PAUSE_DEFAULTS)

    hits = [(d.track_id, d.start, d.end, d.reason.split(":")[0]) for d in proposal.decisions]
    assert hits == [
        ("host", 0.64, 1.52, "filler"),
        ("host", 2.0, 3.45, "pause"),
        ("guest", 0.64, 1.52, "filler"),
    ]
    assert proposal.skip_counts["shared_pause"] == 1
    assert len({d.id for d in project.edit_decisions}) == 3


def test_proposing_without_replacing_never_adds_a_hit_twice(tmp_path: Path) -> None:
    project = _filler_and_pause_project(tmp_path)
    first = propose_tighten_edits(project, FILLER_AND_PAUSE_DEFAULTS)

    again = propose_tighten_edits(project, FILLER_AND_PAUSE_DEFAULTS, replace_existing=False)

    assert again.decisions == []
    assert again.skip_counts == {"same_hit": 2}
    assert project.edit_decisions == first.decisions


def test_hit_ids_separate_track_kind_and_span() -> None:
    base = _CutCandidate(track_id="host", start=1.0, end=1.3, reason="filler:um", cut_kind="filler")
    variants = [
        base,
        _CutCandidate(track_id="guest", start=1.0, end=1.3, reason="filler:um", cut_kind="filler"),
        _CutCandidate(
            track_id="host", start=1.0, end=1.3, reason="repetition:word:um", cut_kind="repeat"
        ),
        _CutCandidate(
            track_id="host", start=1.0, end=1.3, reason="restart:partial:u", cut_kind="restart"
        ),
        _CutCandidate(track_id="host", start=1.0, end=1.4, reason="filler:um", cut_kind="filler"),
        _CutCandidate(track_id="host", start=1.1, end=1.3, reason="filler:um", cut_kind="filler"),
        _CutCandidate(
            track_id="host", start=1.0, end=1.3, reason="pause:1.30s", cut_kind="pause", gap_end=2.3
        ),
        _CutCandidate(
            track_id="host", start=1.0, end=1.3, reason="pause:1.40s", cut_kind="pause", gap_end=2.4
        ),
    ]

    assert len({c.hit_id for c in variants}) == len(variants)
    assert (
        base.hit_id
        == _CutCandidate(
            track_id="host", start=1.0, end=1.3, reason="filler:um:risky", cut_kind="filler"
        ).hit_id
    )


def test_peer_voice_inside_a_session_pause_is_reviewed(tmp_path: Path) -> None:
    """The ripple removes the window from every track; the guest's untranscribed 100 ms
    burst at -32 dBFS averages -45 dBFS over the 2 s window, under the speech-energy
    guard's floor, so only the run check sees it (the lab's lana 673.3 s, in miniature)."""
    host = np.zeros(4 * RATE, dtype=np.float32)
    _voice(host, 0.2, 0.4)
    _voice(host, 3.0, 3.2)
    guest = np.zeros(4 * RATE, dtype=np.float32)
    _voice(guest, 1.5, 1.6, level_db=-32.0)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, host, words, peer=guest)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.60s:solo:interior_speech"
    assert decision.review_required is True
    assert decision.scope == "session"
    assert apply_tighten_decisions(project) == 0


def test_peer_onset_at_the_pause_end_moves_the_edge_before_it(tmp_path: Path) -> None:
    """The guest starts speaking at 2.42 s, 30 ms before the pause cut would end."""
    host = np.zeros(4 * RATE, dtype=np.float32)
    _voice(host, 0.2, 0.4)
    _voice(host, 3.0, 3.2)
    guest = np.zeros(4 * RATE, dtype=np.float32)
    _voice(guest, 2.42, 3.2, level_db=-30.0)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, host, words, peer=guest)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.60s:solo:air_edges"
    assert decision.review_required is False
    # Guest voice edge on the frame grid (2.41) minus 60 ms of air.
    assert decision.end == pytest.approx(2.35, abs=0.011)


def test_unvoiced_material_inside_a_pause_is_not_dead_air(tmp_path: Path) -> None:
    """1.4 s of fricative-like noise at -25 dBFS carries no pitch, so it is not speech to
    the voiced check, but a pause that removes it is not removing dead air."""
    host = np.zeros(4 * RATE, dtype=np.float32)
    _voice(host, 0.2, 0.4)
    _breath(host, 0.8, 2.2, level_db=-25.0)
    _voice(host, 3.0, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, host, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.60s:solo:interior_audio"
    assert decision.review_required is True
    assert apply_tighten_decisions(project) == 0


def test_voice_before_a_filler_word_start_moves_the_cut_to_its_onset(tmp_path: Path) -> None:
    host = np.zeros(4 * RATE, dtype=np.float32)
    _voice(host, 0.30, 0.70)
    _voice(host, 0.90, 1.10)
    _voice(host, 2.0, 2.4)
    words = [
        TranscriptWord(text="um", start=0.50, end=0.70),
        TranscriptWord(text="uh", start=0.90, end=1.10),
        TranscriptWord(text="edits", start=2.0, end=2.4),
    ]
    project = _project(tmp_path, host, words)
    defaults = {
        "tighten": {
            "breath_handling": {"enabled": False},
            "filler_words": ["um", "uh"],
            "discourse_markers": [],
            "acoustic_gap_filler": {"enabled": False},
        }
    }

    um, uh = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)

    # The "um" voices from 0.30 s, 200 ms before its word start (#1061).
    assert um.reason == "filler:um"
    assert um.review_required is False
    assert um.start == pytest.approx(0.28, abs=0.005)
    assert um.end == pytest.approx(0.701, abs=0.005)
    assert uh.reason == "filler:uh"
    assert uh.review_required is False
    assert uh.start == pytest.approx(0.740, abs=0.011)
    assert apply_tighten_decisions(project) == 2


def test_voice_after_a_filler_with_no_word_is_reviewed_not_widened(tmp_path: Path) -> None:
    host = np.zeros(4 * RATE, dtype=np.float32)
    _voice(host, 0.70, 1.00)
    words = [TranscriptWord(text="um", start=0.50, end=0.70)]
    project = _project(tmp_path, host, words)
    candidate = _CutCandidate(
        track_id="host",
        start=0.50,
        end=0.80,
        reason="filler:um",
        cut_kind="filler",
    )

    result = _check_voiced_speech(
        candidate,
        0.50,
        0.80,
        audio_cache=_cache(host),
        word_index=CutWordIndex.build(project, "host"),
        defaults={},
    )

    assert result.start == pytest.approx(0.50)
    assert result.end == pytest.approx(0.80)
    assert result.flag == "voiced_edge"
