"""Piecewise lane latency (#1071): steps found at silences, applied as clip pieces, undone."""

from __future__ import annotations

import json
from bisect import bisect_right
from collections.abc import Callable

import numpy as np
import pytest

import bleed_helpers as bh
from podcast_mcp.edits.bleed_lag_segments import STEP_COSTS, BleedPair, LagSegment, lag_segments
from podcast_mcp.edits.bleed_latency import HOP_SEC
from podcast_mcp.edits.conversation_align import align_artifact_path, plan_conversation_alignment
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB
from podcast_mcp.models import SpeakerIngestAlignment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.history import HistoryService
from podcast_mcp.services.pipeline.service import PipelineService

# Audra is silent from 152.5 s to 212.9 s of the synthetic session; her track's latency
# steps from 120 ms to 200 ms when she resumes, like a jitter buffer after a pause.
RESUMES_SEC = 212.9


def _stepped() -> dict[str, np.ndarray]:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    audio["audra"] = bh.relatency(audio["audra"], lambda t: 0.12 if t < RESUMES_SEC else 0.2)
    return audio


def _from(mic: np.ndarray, lag_sec: float) -> list[BleedPair]:
    """The lane's voice copied onto ``mic``, steady at about ``lag_sec``."""
    return [BleedPair(mic, lane_talks=True, lag_sec=lag_sec)]


def _clips(ws: ProjectWorkspace, track_id: str) -> list[tuple[str, float, float, float]]:
    return [
        (c.id, round(c.source_start, 4), round(c.source_end, 4), round(c.timeline_start, 4))
        for c in sorted(ws.project.clips, key=lambda c: c.timeline_start)
        if c.track_id == track_id
    ]


def test_latency_step_at_a_silence_is_two_segments() -> None:
    audio = _stepped()
    levels = bh.levels(audio)

    found = lag_segments(
        levels["audra"],
        _from(levels["caleb"], 0.14),
        heard=levels["audra"],
        heard_peak=bh.peaks(audio)["audra"],
        deadband_sec=0.02,
    )

    assert found is not None
    segments = found.segments
    assert [(round(s.start_sec, 2), s.shift_sec, s.gap_sec) for s in segments] == [
        (0.0, -0.12, None),
        (182.81, -0.2, (152.535, 213.085)),
    ]


def _worst_error_ms(
    segments: tuple[LagSegment, ...], direct: np.ndarray, latency: Callable[[float], float]
) -> float:
    """Largest gap between a talk spurt's true latency and the latency its segment plays at."""
    starts = [segment.start_sec for segment in segments]
    errors = []
    for first, _last in bh.spurts(direct):
        at = first / bh.RATE
        segment = segments[bisect_right(starts, at) - 1]
        errors.append(abs(-segment.shift_sec - latency(at)))
    return round(max(errors) * 1000, 1)


def test_a_step_is_judged_against_its_merged_neighbours() -> None:
    # After a 21 s pause Audra's latency jumps from 140 to 185 ms on a noisy stretch, then
    # eases to 200 ms after a 7 s pause. 185 and 200 sit inside the 20 ms deadband of each
    # other, so they are one piece, and the step into it belongs in the 21 s pause. Judged
    # against the 185 ms piece alone, a 200 ms piece next to it was forbidden, so the solver
    # moved the step into an earlier silence and played the speech before the pause 30 ms
    # late to make the pieces differ.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    direct = audio["audra"]

    def latency(t: float) -> float:
        return 0.14 if t < 120.0 else (0.185 if t < 140.0 else 0.2)

    audio["audra"] = bh.relatency(direct, latency)
    t = np.arange(audio["caleb"].size) / bh.RATE
    noisy = (t >= 132.0) & (t < 142.3)
    audio["caleb"] += np.where(noisy, 0.003, 0.0) * np.random.default_rng(1).standard_normal(t.size)
    levels = bh.levels(audio)

    found = lag_segments(
        levels["audra"],
        _from(levels["caleb"], 0.15),
        heard=levels["audra"],
        heard_peak=bh.peaks(audio)["audra"],
        deadband_sec=0.02,
    )

    assert found is not None
    segments = found.segments
    assert [(round(s.start_sec, 1), round(-s.shift_sec * 1000)) for s in segments] == [
        (0.0, 140),
        (121.6, 200),
    ]
    assert _worst_error_ms(segments, direct, latency) <= 20.0


def test_a_short_clear_stretch_keeps_its_own_lag() -> None:
    # After a 21 s pause Audra says one 0.6 s phrase 220 ms late, pauses 7 s, and is back
    # at 140 ms. The phrase has 169 source-dominant frames, all at r ~ 1: plenty to pin its
    # lag. A fixed 200-frame floor rejected it as a piece, so it borrowed frames from the
    # next phrase and played the start of that phrase 70 ms late.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    audio["audra"][round(132.7 * bh.RATE) : round(134.9 * bh.RATE)] = 0.0
    direct = audio["audra"]

    def latency(t: float) -> float:
        return 0.22 if 132.0 < t < 135.0 else 0.14

    audio["audra"] = bh.relatency(direct, latency)
    levels = bh.levels(audio)

    found = lag_segments(
        levels["audra"],
        _from(levels["caleb"], 0.15),
        heard=levels["audra"],
        heard_peak=bh.peaks(audio)["audra"],
        deadband_sec=0.02,
    )

    assert found is not None
    segments = found.segments
    assert [(round(s.start_sec, 1), round(-s.shift_sec * 1000), s.frames) for s in segments] == [
        (0.0, 140, 8646),
        (121.7, 220, 169),
        (137.7, 140, 3017),
    ]
    assert _worst_error_ms(segments, direct, latency) <= 20.0


def _phrase_after(dry: np.ndarray, at_sec: float) -> tuple[int, int]:
    """Sample range of the first phrase (spurts under 0.5 s apart) starting after ``at_sec``."""
    spurts = bh.spurts(dry)
    first = next(i for i, (start, _end) in enumerate(spurts) if start / bh.RATE > at_sec)
    last = first
    while last + 1 < len(spurts) and spurts[last + 1][0] - spurts[last][1] < 0.5 * bh.RATE:
        last += 1
    return spurts[first][0], spurts[last][1]


def _lone_phrase_lane(
    dry: dict[str, np.ndarray],
    phrase: tuple[int, int],
    latency: Callable[[float], float],
    *,
    gain: np.ndarray,
    noise: float,
    seed: int,
) -> tuple[list[BleedPair], dict[str, np.ndarray], dict[str, np.ndarray]]:
    """Audra's gated track and Caleb's mic carrying her voice at ``gain``, noisy over ``phrase``."""
    rng = np.random.default_rng(seed)
    t = np.arange(dry["audra"].size)
    caleb = dry["caleb"] + gain * dry["audra"] + 1e-4 * rng.standard_normal(t.size)
    inside = (t >= phrase[0]) & (t < phrase[1])
    caleb += np.where(inside, noise, 0.0) * rng.standard_normal(t.size)
    audio = {"audra": bh.relatency(dry["audra"], latency), "caleb": caleb}
    levels = bh.levels(audio)
    return _from(levels["caleb"], 0.15), levels, bh.peaks(audio)


def test_a_lone_phrase_after_a_pause_keeps_the_lag_its_own_speech_shows() -> None:
    # Audra resumes 200 ms late after a minute's pause with one 3.6 s phrase on a noisy
    # stretch of Caleb's mic, pauses 8 s, and carries on at 200 ms, 10 dB quieter on his mic.
    # The phrase's level relation to its copy matches the speech before the pause, not after.
    # Measured as one window per piece, that shared level relation pulled the phrase into
    # the 140 ms piece before the pause; spurt by spurt, its timing puts it at 200 ms.
    dry = bh.voices()
    phrase = _phrase_after(dry["audra"], 212.0)
    resumes = phrase[1] + round(8.0 * bh.RATE)
    dry["audra"][phrase[1] : resumes] = 0.0
    quieter = np.where(np.arange(dry["audra"].size) < resumes, 0.1, 0.03)

    def latency(t: float) -> float:
        return 0.14 if t < 212.0 else 0.2

    pairs, levels, peaks = _lone_phrase_lane(
        dry, phrase, latency, gain=quieter, noise=0.02, seed=11
    )

    found = lag_segments(
        levels["audra"], pairs, heard=levels["audra"], heard_peak=peaks["audra"], deadband_sec=0.02
    )

    assert found is not None
    assert [(round(s.start_sec, 1), round(-s.shift_sec * 1000)) for s in found.segments] == [
        (0.0, 140),
        (182.8, 200),
    ]


def test_a_noisy_lone_phrase_between_long_pauses_keeps_its_own_lag() -> None:
    # Between a 10 s and a 15 s pause Audra says one 2.7 s phrase 170 ms late, on a noisy
    # stretch of Caleb's mic; the rest of her track is 140 ms late. The phrase's lag is not
    # pinned as tightly as the deadband, but its spurts each prefer 170 ms. A piece measured
    # as one window diluted them below that pin, and leaving each fold's spurts out of the
    # cross-validation left the phrase nothing to be predicted from, so the lane got no
    # steps and the phrase played 30 ms early.
    dry = bh.voices()
    phrase = _phrase_after(dry["audra"], 120.0)
    dry["audra"][phrase[0] - round(10.0 * bh.RATE) : phrase[0]] = 0.0
    dry["audra"][phrase[1] : phrase[1] + round(15.0 * bh.RATE)] = 0.0
    span = (phrase[0] / bh.RATE - 0.01, phrase[1] / bh.RATE)

    def latency(t: float) -> float:
        return 0.17 if span[0] <= t < span[1] else 0.14

    pairs, levels, peaks = _lone_phrase_lane(dry, phrase, latency, gain=0.1, noise=0.02, seed=5)

    found = lag_segments(
        levels["audra"], pairs, heard=levels["audra"], heard_peak=peaks["audra"], deadband_sec=0.02
    )

    assert found is not None
    assert [(round(s.start_sec, 1), round(-s.shift_sec * 1000)) for s in found.segments] == [
        (0.0, 140),
        (121.6, 165),
        (142.4, 140),
    ]


def test_a_blip_is_noise_and_an_easing_is_a_step() -> None:
    # Audra resumes 200 ms late after a minute's pause and eases to 160 ms after 4.5 s:
    # two clear steps. In the pause a 40 ms click on her track lines up with one on
    # Caleb's mic at 100 ms. Its 48 dominant frames correlate perfectly at that lag, yet
    # one click is a single event, not a lag to play a piece at.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))

    def latency(t: float) -> float:
        return 0.14 if t < 200.0 else (0.2 if t < 218.0 else 0.16)

    audio["audra"] = bh.relatency(audio["audra"], latency)
    levels = bh.levels(audio)
    source, mic = levels["audra"], levels["caleb"]
    at = round(180.0 / HOP_SEC)
    early = at - round(0.1 / HOP_SEC)
    click = -30.0 + 10.0 * np.hanning(10)[1:-1]
    mic[early - 100 : early + 108] = LEVEL_FLOOR_DB
    source[at : at + 8] = click
    mic[early : early + 8] = click - 20.0

    # The click is drawn on the envelopes; its RMS frames stand in for its peaks.
    found = lag_segments(
        source, _from(mic, 0.15), heard=source, heard_peak=source, deadband_sec=0.02
    )

    assert found is not None
    segments = found.segments
    assert [(round(s.start_sec, 1), round(-s.shift_sec * 1000)) for s in segments] == [
        (0.0, 140),
        (196.6, 200),
        (218.9, 160),
    ]


def test_steps_show_through_the_other_voice_on_the_lane_mic() -> None:
    # Audra's own voice reaches no other mic, but Caleb's voice reaches hers. Her whole
    # track is 120 ms late, then 200 ms late after a silence at 111-117 s, so Caleb's copy
    # on her track steps with it.
    raw = bh.tracks(bleed={"audra": {"caleb": 0.0}})
    cut = round(116.6 * bh.RATE)
    late = np.concatenate([bh.delay(raw["audra"], 0.12)[:cut], bh.delay(raw["audra"], 0.2)[cut:]])
    audio = {"audra": late, "caleb": raw["caleb"]}
    levels = bh.levels(audio)

    found = lag_segments(
        levels["audra"],
        [BleedPair(levels["caleb"], lane_talks=False, lag_sec=0.15)],
        heard=levels["audra"],
        heard_peak=bh.peaks(audio)["audra"],
        deadband_sec=0.02,
    )

    assert found is not None
    segments = found.segments
    assert [(round(s.start_sec, 2), s.shift_sec, s.gap_sec) for s in segments] == [
        (0.0, -0.12, None),
        (114.05, -0.2, (111.015, 117.08)),
    ]


def test_steps_use_a_mic_other_than_the_reference(tmp_path) -> None:
    # Audra's voice reaches only Lana's mic, and Lana's reaches Caleb's (the reference).
    # Audra's step shows on the Audra -> Lana pair once Lana sits on the reference clock;
    # Lana herself is on time and stays one piece.
    audio = bh.tracks(bleed={"lana": {"audra": 0.0}, "caleb": {"lana": 0.0}}, gated=("audra",))
    audio["audra"] = bh.relatency(audio["audra"], lambda t: 0.12 if t < RESUMES_SEC else 0.2)
    ws = bh.workspace(tmp_path, audio)

    result = plan_conversation_alignment(ws.project)

    assert [
        (p.track_id, p.method, round(p.offset_sec, 3), [(round(a, 4), o) for a, o in p.steps])
        for p in result.plans
    ] == [
        ("caleb", "reference", 0.0, []),
        ("audra", "bleed_lag", -0.12, [(182.65, -0.2)]),
        ("lana", "hold", 0.0, []),
    ]


def test_a_step_never_skips_a_peak_the_rms_gate_misses() -> None:
    # Mid-pause, right where the 80 ms step would go, Audra's track has a one-sample click
    # at -40 dBFS. Its 30 ms RMS is -64 dB, under the -60 dB silence gate, so the step
    # skipped it. The skipped or repeated audio must also peak below -50 dBFS.
    audio = _stepped()
    click = round(182.81 * bh.RATE)
    audio["audra"][click] = 0.01
    levels = bh.levels(audio)

    found = lag_segments(
        levels["audra"],
        _from(levels["caleb"], 0.14),
        heard=levels["audra"],
        heard_peak=bh.peaks(audio)["audra"],
        deadband_sec=0.02,
    )

    assert found is not None
    segments = found.segments
    step = segments[1]
    skipped = (step.start_sec - 0.04, step.start_sec + 0.04)
    assert not skipped[0] <= click / bh.RATE <= skipped[1]
    assert [(round(s.start_sec, 2), s.shift_sec, s.gap_sec) for s in segments] == [
        (0.0, -0.12, None),
        (197.95, -0.2, (182.815, 213.085)),
    ]


def test_the_step_cost_is_chosen_per_recording() -> None:
    # A jitter buffer re-times Audra to 200 ms after each pause over 3 s and eases her back
    # 30 ms at a time after shorter ones, down to 140 ms, on a noisy room mic. On this
    # recording a fixed 10-nat step cost merged three phrases into a piece 30 ms off;
    # cross-validation picks the cost from the recording's own held-out speech.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",), seed=10)
    plan: dict[int, float] = {}
    level, end = 0.14, 0
    for first, last in bh.spurts(audio["audra"]):
        pause = (first - end) / bh.RATE
        level = 0.2 if pause > 3.0 else (max(0.14, level - 0.03) if pause > 0.5 else level)
        plan[first], end = level, last
    direct = audio["audra"]

    def latency(t: float) -> float:
        return plan[round(t * bh.RATE)]

    audio["audra"] = bh.relatency(direct, latency)
    audio["caleb"] += 0.01 * np.random.default_rng(10).standard_normal(audio["caleb"].size)
    levels = bh.levels(audio)

    found = lag_segments(
        levels["audra"],
        _from(levels["caleb"], 0.15),
        heard=levels["audra"],
        heard_peak=bh.peaks(audio)["audra"],
        deadband_sec=0.02,
    )

    assert found is not None
    assert found.step_cost < STEP_COSTS[-1]
    assert _worst_error_ms(found.segments, direct, latency) <= 5.0


def test_jitter_inside_the_deadband_is_one_segment() -> None:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    rng = np.random.default_rng(3)
    audio["audra"] = bh.relatency(audio["audra"], lambda _t: 0.12 + rng.uniform(-0.008, 0.008))
    levels = bh.levels(audio)

    assert (
        lag_segments(
            levels["audra"],
            _from(levels["caleb"], 0.12),
            heard=levels["audra"],
            heard_peak=bh.peaks(audio)["audra"],
            deadband_sec=0.02,
        )
        is None
    )


@pytest.fixture
def stepped(tmp_path) -> ProjectWorkspace:
    return bh.workspace(tmp_path, _stepped())


def test_align_tracks_splits_the_lane_in_the_silence_and_undo_restores(
    stepped: ProjectWorkspace,
) -> None:
    PipelineService(stepped).run(only_step="align_tracks", unattended=True)

    pieces = _clips(stepped, "audra")
    # The step sits mid-silence (182.81 s of Audra's file): the first piece plays her
    # file 120 ms early, the second 200 ms early, and the 80 ms between them is silence.
    assert [tuple(geometry) for _id, *geometry in pieces] == [
        (0.12, 182.77, 0.0),
        (182.85, 240.0, 182.65),
    ]
    assert not np.any(_stepped()["audra"][round(182.77 * bh.RATE) : round(182.85 * bh.RATE)])
    artifact = json.loads(align_artifact_path(stepped.project).read_text())["bleed_lag_segments"]
    assert (artifact["audra"]["step_cost"], len(artifact["audra"]["segments"])) == (64.0, 2)
    labels = [entry.label for entry in stepped.project.history.entries]
    assert labels == ["initial", "before pipeline run", "after align_tracks"]

    HistoryService(stepped).goto(labels.index("before pipeline run"))

    assert _clips(stepped, "audra") == [("clip_audra", 0.0, 240.0, 0.0)]


def _methods(ws: ProjectWorkspace) -> dict[str, str]:
    return {
        key: entry.align_method for key, entry in (ws.project.meta.ingest_alignment or {}).items()
    }


def test_rerun_keeps_the_pieces_where_they_are(stepped: ProjectWorkspace) -> None:
    PipelineService(stepped).run(only_step="align_tracks", unattended=True)
    once = _clips(stepped, "audra")
    methods = _methods(stepped)
    labels = [entry.label for entry in stepped.project.history.entries]

    result = PipelineService(stepped).run(only_step="align_tracks", unattended=True)

    assert _clips(stepped, "audra") == once
    assert "kept audra" in (result.steps[-1].message or "")
    # Nothing moved, so the pieces keep the method that placed them and no undo entry is added.
    assert _methods(stepped) == methods
    assert sorted(set(methods.values())) == ["bleed_lag", "hold", "reference"]
    assert [entry.label for entry in stepped.project.history.entries] == labels


def test_rerun_finds_the_same_pieces_wherever_the_first_piece_sits(tmp_path) -> None:
    # Audra's first minute is 220 ms late and the rest 120 ms. After one run her first
    # piece plays 215 ms early while the latency solve reads the placed lane as aligned. If
    # a pair's steady lag came from that placement, a re-run would search around 215 ms
    # instead of 120 and cut a new piece; it must come from her media.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    audio["audra"] = bh.relatency(audio["audra"], lambda t: 0.22 if t < 63.4 else 0.12)
    ws = bh.workspace(tmp_path, audio)
    PipelineService(ws).run(only_step="align_tracks", unattended=True)
    once = _clips(ws, "audra")
    labels = [entry.label for entry in ws.project.history.entries]

    PipelineService(ws).run(only_step="align_tracks", unattended=True)

    assert _clips(ws, "audra") == once
    assert [entry.label for entry in ws.project.history.entries] == labels


def test_drifting_lane_is_flagged_and_not_split(tmp_path) -> None:
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    index = np.arange(audio["audra"].size)
    late = (0.02 + 0.12 * index / index.size) * bh.RATE
    audio["audra"] = np.interp(index - late, index, audio["audra"], left=0.0)
    ws = bh.workspace(tmp_path, audio)

    result = plan_conversation_alignment(ws.project)

    audra = [(p.method, p.offset_sec, p.steps) for p in result.plans if p.track_id == "audra"]
    assert audra == [("hold", 0.0, ())]
    assert "bleed lag drifting: audra (left in place)" in result.summary()


@pytest.mark.parametrize(("late", "step_at"), [(0.155, 121.47), (0.2, 121.47)])
def test_a_long_step_is_split_not_read_as_drift_or_scatter(
    tmp_path, late: float, step_at: float
) -> None:
    # Audra's latency steps from 120 ms to ``late`` in her 21 s pause and stays there for
    # the second half. A 35 ms step read as a trend across the windows (drifting); an
    # 80 ms one left half the windows away from the median (scattered). Either way the
    # lane stayed where it was.
    audio = bh.tracks(bleed={"caleb": {"audra": 0.0}}, gated=("audra",))
    audio["audra"] = bh.relatency(audio["audra"], lambda t: 0.12 if t < 120.0 else late)
    ws = bh.workspace(tmp_path, audio)

    result = plan_conversation_alignment(ws.project)

    audra = [
        (p.method, round(p.offset_sec, 3), [(round(at, 2), round(o, 3)) for at, o in p.steps])
        for p in result.plans
        if p.track_id == "audra"
    ]
    assert audra == [("bleed_lag", -0.12, [(step_at, -late)])]


def test_manifest_pin_proposes_one_shift_and_keeps_the_clip_whole(
    stepped: ProjectWorkspace,
) -> None:
    stepped.project.meta.ingest_alignment = {
        "Audra": SpeakerIngestAlignment(
            session_start_in_file_sec=0.0, content_align_sec=0.0, align_method="manual"
        )
    }

    result = plan_conversation_alignment(stepped.project)

    audra = [
        (p.method, p.offset_sec, round(p.candidate_offset_sec or 0.0, 2), p.steps)
        for p in result.plans
        if p.track_id == "audra"
    ]
    assert audra == [("manual", 0.0, -0.12, ())]
