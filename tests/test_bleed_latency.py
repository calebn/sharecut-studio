"""Per-track recording latency from bleed (#1037): measure pairs, solve, align, undo."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import bleed_helpers as bh
from podcast_mcp.edits.bleed_latency import TrackLatency, measure_bleed_latency
from podcast_mcp.edits.conversation_align import (
    AcousticOffset,
    plan_conversation_alignment,
    run_conversation_align,
)
from podcast_mcp.models import (
    SpeakerIngestAlignment,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.history import HistoryService
from podcast_mcp.services.pipeline.service import PipelineService


def _summary(solution) -> dict[str, tuple[float | None, str, str]]:
    return {
        t.track_id: (
            None if t.latency_sec is None else round(t.latency_sec, 2),
            t.reason,
            t.decision,
        )
        for t in solution.tracks
    }


def test_late_track_recovered_from_its_bleed_on_two_mics() -> None:
    tracks = bh.tracks(
        bleed={"caleb": {"audra": 0.0}, "lana": {"audra": 0.0}},
        latency={"audra": 0.12},
        gated=("audra",),
    )

    solution = measure_bleed_latency(bh.levels(tracks), "caleb")

    assert _summary(solution) == {
        "caleb": (0.0, "reference", "keep"),
        "audra": (0.12, "latency", "apply"),
        "lana": (0.0, "aligned", "keep"),
    }
    consistent = {
        (p.source_track_id, p.mic_track_id): round(p.lag_sec or 0.0, 2)
        for p in solution.pairs
        if p.reason == "consistent"
    }
    assert consistent == {("audra", "caleb"): 0.12, ("audra", "lana"): 0.12}


def test_conflicting_pairs_flag_the_track_instead_of_shifting_it() -> None:
    # Audra's copy reaches Caleb's mic 300 ms late (a loudspeaker loop), while Caleb's
    # copy on Audra's mic is on time: no single latency explains both pairs.
    tracks = bh.tracks(bleed={"caleb": {"audra": 0.3}, "audra": {"caleb": 0.0}})

    solution = measure_bleed_latency(bh.levels(tracks), "caleb")

    assert _summary(solution) == {
        "caleb": (0.0, "conflict", "flag"),
        "audra": (-0.15, "conflict", "flag"),
        "lana": (None, "no_bleed_evidence", "keep"),
    }
    residuals = sorted(round(p.residual_sec, 2) for p in solution.pairs if p.residual_sec)
    assert residuals == [-0.15, -0.15]


def test_drifting_lag_is_flagged_not_solved() -> None:
    tracks = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    # Audra's clock runs slow: her lag grows from 20 ms to 140 ms across the episode.
    index = np.arange(tracks["audra"].size)
    late = (0.02 + 0.12 * index / index.size) * bh.RATE
    tracks["audra"] = np.interp(index - late, index, tracks["audra"], left=0.0)

    solution = measure_bleed_latency(bh.levels(tracks), "caleb")

    assert _summary(solution) == {
        "caleb": (0.0, "reference", "keep"),
        "audra": (None, "drifting", "flag"),
        "lana": (None, "no_bleed_evidence", "keep"),
    }
    drift = next(p for p in solution.pairs if p.reason == "drifting")
    assert (drift.source_track_id, drift.mic_track_id) == ("audra", "caleb")


def test_copy_whose_delay_jumps_between_windows_is_scattered() -> None:
    tracks = bh.tracks(bleed={}, gated=("audra",))
    voices = bh.voices()
    window = round(30.0 * bh.RATE)
    for i, delay in enumerate((0.0, 0.3, 0.1, 0.4, 0.2, 0.0, 0.3, 0.1)):
        part = slice(i * window, (i + 1) * window)
        tracks["caleb"][part] += 0.1 * bh.delay(voices["audra"], delay)[part]

    solution = measure_bleed_latency(bh.levels(tracks), "caleb")

    pair = next(
        p for p in solution.pairs if p.source_track_id == "audra" and p.mic_track_id == "caleb"
    )
    assert (pair.reason, pair.lag_sec) == ("scattered", None)
    assert solution.track("audra") == TrackLatency("audra", None, "no_bleed_evidence")


def test_loudspeaker_loop_on_one_pair_is_proposed_never_applied() -> None:
    # Lana is on time; her voice reaches Caleb's room mic through a loudspeaker 300 ms
    # later. A copy that arrives after the direct sound does not prove latency.
    outcomes = [
        _summary(
            measure_bleed_latency(
                bh.levels(bh.tracks(bleed={"caleb": {"lana": 0.3}}, seed=seed)), "caleb"
            )
        )["lana"]
        for seed in range(20)
    ]

    assert outcomes == [(-0.3, "copy_later", "propose")] * 20


def test_copy_later_on_every_mic_is_still_only_proposed() -> None:
    # A remote voice played into two rooms arrives late on both mics by the same delay,
    # so agreeing pairs cannot tell a loudspeaker from latency.
    solution = measure_bleed_latency(
        bh.levels(bh.tracks(bleed={"caleb": {"lana": 0.3}, "audra": {"lana": 0.3}})), "caleb"
    )

    lana = solution.track("lana")
    assert lana is not None
    assert (round(lana.latency_sec or 0.0, 2), lana.reason, lana.decision, lana.pairs) == (
        -0.3,
        "copy_later",
        "propose",
        2,
    )


def test_no_bleed_abstains() -> None:
    solution = measure_bleed_latency(bh.levels(bh.tracks(bleed={}, gated=bh.SPEAKERS)), "caleb")

    assert _summary(solution) == {
        "caleb": (0.0, "reference", "keep"),
        "audra": (None, "no_bleed_evidence", "keep"),
        "lana": (None, "no_bleed_evidence", "keep"),
    }
    assert {p.reason for p in solution.pairs} == {"no_bleed"}


@pytest.fixture
def late_audra(tmp_path: Path) -> ProjectWorkspace:
    return bh.workspace(
        tmp_path,
        bh.tracks(
            bleed={"caleb": {"audra": 0.0}, "lana": {"audra": 0.0}},
            latency={"audra": 0.12},
            gated=("audra",),
        ),
    )


def test_align_tracks_shifts_a_held_late_track_and_undo_restores(
    late_audra: ProjectWorkspace,
) -> None:
    PipelineService(late_audra).run(only_step="align_tracks", unattended=True)

    artifact = json.loads(
        (late_audra.project.artifacts_dir() / "alignment" / "conversation_align.json").read_text()
    )
    plans = {p["track_id"]: (p["method"], round(p["offset_sec"], 2)) for p in artifact["plans"]}
    assert plans == {
        "caleb": ("reference", 0.0),
        "audra": ("bleed_lag", -0.12),
        "lana": ("hold", 0.0),
    }
    assert bh.geometry(late_audra, "audra") == (0.12, 240.0, 0.0)
    assert bh.geometry(late_audra, "lana") == (0.0, 240.0, 0.0)

    labels = [entry.label for entry in late_audra.project.history.entries]
    HistoryService(late_audra).goto(labels.index("before pipeline run"))

    assert bh.geometry(late_audra, "audra") == (0.0, 240.0, 0.0)


def test_rerun_measures_at_the_aligned_placement_and_keeps_it(
    late_audra: ProjectWorkspace,
) -> None:
    PipelineService(late_audra).run(only_step="align_tracks", unattended=True)
    labels = [entry.label for entry in late_audra.project.history.entries]
    PipelineService(late_audra).run(only_step="align_tracks", unattended=True)

    assert bh.geometry(late_audra, "audra") == (0.12, 240.0, 0.0)
    assert late_audra.project.meta.ingest_alignment is not None
    assert late_audra.project.meta.ingest_alignment["Audra"].align_method == "bleed_lag"
    assert [entry.label for entry in late_audra.project.history.entries] == labels
    latency = json.loads(
        (late_audra.project.artifacts_dir() / "alignment" / "conversation_align.json").read_text()
    )["bleed_latency"]
    assert {t["track_id"]: t["reason"] for t in latency["tracks"]} == {
        "caleb": "reference",
        "audra": "aligned",
        "lana": "aligned",
    }


def test_manifest_pin_keeps_placement_and_proposes_the_shift(
    late_audra: ProjectWorkspace,
) -> None:
    late_audra.project.meta.ingest_alignment = {
        "Audra": SpeakerIngestAlignment(
            session_start_in_file_sec=0.0, content_align_sec=0.0, align_method="manual"
        )
    }

    result = plan_conversation_alignment(late_audra.project)

    audra = next(p for p in result.plans if p.track_id == "audra")
    assert (audra.method, audra.offset_sec, round(audra.candidate_offset_sec or 0.0, 2)) == (
        "manual",
        0.0,
        -0.12,
    )
    assert "audra: bleed lag -0.12s proposed" in result.summary()


def test_conflicting_pairs_leave_placement_and_flag_it(tmp_path: Path) -> None:
    ws = bh.workspace(tmp_path, bh.tracks(bleed={"caleb": {"audra": 0.3}, "audra": {"caleb": 0.0}}))

    result = plan_conversation_alignment(ws.project)

    audra = next(p for p in result.plans if p.track_id == "audra")
    assert (audra.method, audra.offset_sec) == ("hold", 0.0)
    assert "bleed lag pairs conflict: audra" in result.summary()


def test_loudspeaker_loop_keeps_placement_and_proposes_even_on_realign(tmp_path: Path) -> None:
    ws = bh.workspace(tmp_path, bh.tracks(bleed={"caleb": {"lana": 0.15}}))

    result = plan_conversation_alignment(ws.project)
    PipelineService(ws).run(
        only_step="align_tracks", unattended=True, config={"align": {"realign": True}}
    )

    lana = next(p for p in result.plans if p.track_id == "lana")
    assert (lana.method, lana.offset_sec, round(lana.candidate_offset_sec or 0.0, 2)) == (
        "hold",
        0.0,
        0.15,
    )
    assert (
        "lana: bleed lag +0.15s proposed (a copy arrives 150 ms after the direct sound on 1 pair"
        in result.summary()
    )
    assert bh.geometry(ws, "lana") == (0.0, 240.0, 0.0)


_PHRASES = ("one two three", "four five six", "seven eight nine", "ten eleven twelve")


def _words(shift: float) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=word, start=start, end=start + 0.25, confidence=0.9)
        for i, phrase in enumerate(_PHRASES)
        for j, word in enumerate(phrase.split())
        for start in (10.0 * (i + 1) + 0.3 * j + shift,)
    ]


@pytest.mark.parametrize("first_realign", [False, True])
def test_realign_lands_on_the_latency_and_then_makes_no_move(
    late_audra: ProjectWorkspace, first_realign: bool
) -> None:
    # The re-scored placement lands 44 ms early and off the 5 ms envelope grid, like the
    # lab's -182 ms waveform match. Seen from where Audra sits, her direct track trails
    # her copy, so the bleed solve corrects the overshoot; after that nothing moves.
    late_audra.project.transcripts.append(Transcript(track_id="caleb", words=_words(0.0)))
    late_audra.project.transcripts.append(Transcript(track_id="audra", words=_words(0.1637)))
    rescored = {
        "align": {"realign": True, "min_bleed_matches": 2},
        "_align_acoustic_fn": lambda _ref, _src: AcousticOffset(
            -0.1637, peak=0.2, n_windows=5, detail="stub waveform match"
        ),
    }

    run_conversation_align(late_audra.project, defaults=rescored if first_realign else None)
    aligned = bh.geometry(late_audra, "audra")
    run_conversation_align(late_audra.project, defaults=rescored)
    once = bh.geometry(late_audra, "audra")
    again = run_conversation_align(late_audra.project, defaults=rescored)

    assert (aligned, once, bh.geometry(late_audra, "audra")) == ((0.12, 240.0, 0.0),) * 3
    assert "kept audra, lana (bleed lag inside the deadband; not moved)" in again.summary()


def test_align_settings_override_tolerance_and_deadband(tmp_path: Path) -> None:
    late = bh.workspace(
        tmp_path / "late",
        bh.tracks(
            bleed={"caleb": {"audra": 0.0}, "lana": {"audra": 0.0}},
            latency={"audra": 0.12},
            gated=("audra",),
        ),
    )
    looped = bh.workspace(
        tmp_path / "loop", bh.tracks(bleed={"caleb": {"audra": 0.3}, "audra": {"caleb": 0.0}})
    )

    def audra(ws: ProjectWorkspace, align: dict[str, float]) -> tuple[str, float, str | None]:
        result = plan_conversation_alignment(ws.project, defaults={"align": align})
        plan = next(p for p in result.plans if p.track_id == "audra")
        found = result.latency.track("audra") if result.latency else None
        return plan.method, round(plan.offset_sec, 2), found.reason if found else None

    assert audra(late, {}) == ("bleed_lag", -0.12, "latency")
    assert audra(late, {"bleed_lag_deadband_sec": 0.15}) == ("hold", 0.0, "aligned")
    assert audra(looped, {}) == ("hold", 0.0, "conflict")
    assert audra(looped, {"bleed_lag_tolerance_sec": 0.2}) == ("hold", 0.0, "aligned")
