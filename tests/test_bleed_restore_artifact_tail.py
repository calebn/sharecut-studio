from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.bleed_gate import BleedGatePlan
from podcast_mcp.engines.bleed_restore import RestoreSupport
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.render_clock import read_render_clock
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.transcript_gated_play import (
    apply_bleed_gate_plan,
    apply_restored_bleed_gate_plan,
)
from podcast_mcp.models import ClipOffSpeakerMuteRegion, ProcessingChain, ProcessingEffect
from test_bleed_restore_core import RATE, _pcm, _project, _render, _restore


@pytest.mark.parametrize("delay", [0.10051, 0.15049])
@pytest.mark.parametrize("effect", ["acompressor", "loudnorm"])
@pytest.mark.parametrize("late_gate", [False, True])
def test_fractional_delay_restore_preserves_full_nonlinear_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    delay: float,
    effect: str,
    late_gate: bool,
) -> None:
    project = _project(tmp_path)
    project.clips = project.clips[:1]
    project.clips[0].timeline_start = delay
    project.clips[0].off_speaker_mute_regions = [ClipOffSpeakerMuteRegion(start_s=0.1, end_s=0.95)]
    project.tracks[0].transcript_gate = late_gate
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[
                ProcessingEffect(
                    effect=effect,
                    params={"threshold_db": -24, "ratio": 8} if effect == "acompressor" else {},
                )
            ],
        )
    ]
    plan = BleedGatePlan(
        attenuation_spans=((0, 3),) if late_gate else (),
        fade_sec=0.02,
        reduction="attenuate",
        attenuation_db=20,
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan", lambda *_, **_kw: plan
    )
    baseline = _render(project, tmp_path / "baseline.wav", None)
    project.clips[0] = _restore(project.clips[0], tmp_path / "source.wav", [(0.3, 0.9)])
    engine = FFmpegEngine()
    real_render = engine.render_timeline
    branches, clocks = [], []

    def capture(path, audio, af, **kwargs):
        result = real_render(path, audio, af, **kwargs)
        branches.append(_pcm(path))
        clocks.append(read_render_clock(kwargs["clock_path"]))
        return result

    monkeypatch.setattr(engine, "render_timeline", capture)
    output = tmp_path / "restored.wav"
    render_track_from_timeline(project, project.tracks[0], output, {}, engine=engine)
    actual = _pcm(output)
    assert len(branches) == (3 if late_gate else 2)
    assert all(clock == clocks[0] for clock in clocks)
    with wave.open(str(output), "rb") as stream:
        rate = stream.getframerate()
    assert len(actual) == len(baseline) == clocks[0].output.frames
    delay_frames = math.floor(delay * RATE + 0.5)
    placed_end = (delay_frames + RATE) * rate // RATE
    editorial_end = round((delay + 1) * rate)
    assert len(actual) == placed_end
    g = plan.gains_for_frames(0, len(actual), rate)
    g[editorial_end:] = 1
    u, w = branches[:2]
    b = (u.astype(np.float32) * g[:, None]).astype("<i2")
    lifted = (w.astype(np.float32) * g[:, None]).astype("<i2")
    np.testing.assert_array_equal(baseline, b)
    first = (delay_frames + math.ceil(0.3 * RATE)) * rate // RATE
    last = (delay_frames + math.ceil(0.9 * RATE)) * rate // RATE
    frames = np.arange(len(actual))
    support = (frames >= first) & (frames < last)
    width = min(round(plan.fade_sec * rate), (last - first) // 2)
    h = np.zeros(len(actual))
    h[support] = np.minimum(
        1, np.minimum((frames[support] - first) / width, (last - 1 - frames[support]) / width)
    )
    correction = lifted.astype(np.float64) - b.astype(np.float64)
    if late_gate:
        correction += (1 - g)[:, None] * (w.astype(np.float64) - branches[2].astype(np.float64))
    expected = np.clip(b.astype(np.float64) + h[:, None] * correction, -32768, 32767).astype("<i2")
    assert np.any(actual[support] != baseline[support])
    np.testing.assert_array_equal(actual[~support], baseline[~support])
    np.testing.assert_array_equal(actual, expected)


def _write_pcm(path: Path, samples: np.ndarray, *, metadata: bool) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(10)
        stream.writeframes(samples.tobytes())
    if metadata:
        raw = path.read_bytes()
        chunk = b"JUNK" + (4).to_bytes(4, "little") + b"test"
        raw = raw[:12] + chunk + raw[12:]
        path.write_bytes(raw[:4] + (len(raw) - 8).to_bytes(4, "little") + raw[8:])


@pytest.mark.parametrize("metadata_branch", ["authored", "whole", "without"])
@pytest.mark.parametrize("timeline_end", [0.0, 1.1, 2.0])
def test_restore_artifact_extent_and_riff_offsets_keep_legacy_gate_bound(
    tmp_path: Path, metadata_branch: str, timeline_end: float
) -> None:
    values = {
        "authored": np.full((18, 2), 2000, dtype="<i2"),
        "whole": np.full((18, 2), 8000, dtype="<i2"),
        "without": np.full((18, 2), 1000, dtype="<i2"),
    }
    paths = {name: tmp_path / f"{name}.wav" for name in values}
    for name, samples in values.items():
        _write_pcm(paths[name], samples, metadata=name == metadata_branch)
    baseline_path = tmp_path / "baseline.wav"
    baseline_path.write_bytes(paths["authored"].read_bytes())
    plan = BleedGatePlan(
        attenuation_spans=((0, 3),), fade_sec=0.1, reduction="attenuate", attenuation_db=20
    )
    apply_bleed_gate_plan(baseline_path, plan, timeline_start=0, timeline_end=timeline_end)
    support = RestoreSupport(2, 16, 2, 16, 0, 10, 0, 10)
    apply_restored_bleed_gate_plan(
        paths["whole"],
        paths["without"],
        plan,
        (support,),
        timeline_start=0,
        timeline_end=timeline_end,
        authored_path=paths["authored"],
    )
    actual = _pcm(paths["whole"])
    baseline = _pcm(baseline_path)
    g = plan.gains_for_frames(0, len(actual), 10)
    g[round(timeline_end * 10) :] = 1
    lifted = (values["whole"].astype(np.float32) * g[:, None]).astype("<i2")
    h = np.zeros(18)
    h[3:15] = 1
    expected = np.clip(
        baseline.astype(np.float64)
        + h[:, None]
        * (
            lifted.astype(np.float64)
            - baseline.astype(np.float64)
            + (1 - g)[:, None]
            * (values["whole"].astype(np.float64) - values["without"].astype(np.float64))
        ),
        -32768,
        32767,
    ).astype("<i2")
    assert actual.shape == (18, 2)
    np.testing.assert_array_equal(actual[h == 0], baseline[h == 0])
    np.testing.assert_array_equal(actual, expected)
