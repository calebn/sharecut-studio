"""The gain a clip's edge fades and its track's volume envelope render, pinned to a fixture.

``gui/web/src/audio/gainCurve.test.ts`` reads the same file, so the browser preview's
evaluator and the FFmpeg render cannot drift apart (#1649).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import AutomationEnvelope, AutomationPoint
from podcast_mcp.util.binaries import resolve_ffmpeg

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "gain_curve" / "cases.json").read_text()
)
_SAMPLE_RATE = 48_000


def _render_unit_clip(case: dict) -> np.ndarray:
    """What the render does to a clip of constant 1.0: edge fades, then the track envelope."""
    clip = case["clip"]
    engine = FFmpegEngine()
    filters = engine._fade_chain(clip["end"] - clip["start"], clip["fade_in"], clip["fade_out"])
    if case["points"]:
        envelope = AutomationEnvelope(
            track_id="t",
            points=[
                AutomationPoint(id=str(i), time=p["time"], value=p["value"])
                for i, p in enumerate(case["points"])
            ],
        )
        expression = engine._volume_expression(envelope, timeline_origin_sec=clip["start"])
        filters.append(f"volume=volume='{expression}':eval=frame")
    raw = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=1:d={clip['end'] - clip['start']}:s={_SAMPLE_RATE}",
            "-af",
            ",".join(filters) or "anull",
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


@pytest.mark.parametrize("case", _FIXTURE["cases"], ids=lambda case: case["name"])
def test_render_gain_matches_the_fixture_the_preview_is_tested_against(case: dict) -> None:
    rendered = _render_unit_clip(case)
    for at, expected in case["samples"]:
        index = min(rendered.size - 1, round((at - case["clip"]["start"]) * _SAMPLE_RATE))
        assert rendered[index] == pytest.approx(expected, abs=2e-3, rel=1e-2), (case["name"], at)


_MUTE_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "gain_curve" / "mute_cases.json").read_text()
)


def _render_unit_mute(case: dict) -> np.ndarray:
    """What the render does to a clip of constant 1.0 under its mute regions."""
    from podcast_mcp.engines.mute_regions import mute_spans_for_source_window
    from podcast_mcp.models import Clip, ClipMuteRegion

    start, end = case["clip"]["source_start"], case["clip"]["source_end"]
    clip = Clip(
        id="c",
        track_id="t",
        source_start=start,
        source_end=end,
        timeline_start=0.0,
        mute_regions=[ClipMuteRegion(**region) for region in case["regions"]],
    )
    chain = FFmpegEngine()._mute_chain(
        end - start,
        mute_spans_for_source_window(
            clip, start, end, [ClipMuteRegion(**region) for region in case.get("ignored", [])]
        ),
        sample_rate=_SAMPLE_RATE,
        source_start=start,
        origin=round(start * _SAMPLE_RATE),
    )
    raw = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=1:d={end - start}:s={_SAMPLE_RATE}",
            "-af",
            ",".join(chain) or "anull",
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


@pytest.mark.parametrize("case", _MUTE_FIXTURE["cases"], ids=lambda case: case["name"])
def test_render_mute_gain_matches_the_fixture_the_preview_is_tested_against(case: dict) -> None:
    rendered = _render_unit_mute(case)
    start = case["clip"]["source_start"]
    for at, expected in case["samples"]:
        index = min(rendered.size - 1, round((at - start) * _SAMPLE_RATE))
        assert rendered[index] == pytest.approx(expected, abs=2e-3), (case["name"], at)


_AUTOMATIC_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "gain_curve" / "automatic_cases.json").read_text()
)


def _render_unit_automatic(case: dict) -> np.ndarray:
    """What the render does to a clip of constant 1.0 under its off-speaker mute regions."""
    from podcast_mcp.engines.audio import SourceFrameMapping, SourceMuteEnvelope
    from podcast_mcp.engines.ffmpeg import automatic_gain_expression

    start, end = case["clip"]["source_start"], case["clip"]["source_end"]
    mapping = SourceFrameMapping(_SAMPLE_RATE, round(start * _SAMPLE_RATE), ())
    gain = automatic_gain_expression(
        tuple(
            SourceMuteEnvelope(
                r["start_s"], r["end_s"], r["fade_out_ms"] / 1000, r["fade_in_ms"] / 1000
            )
            for r in case["regions"]
        ),
        mapping,
    )
    raw = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=1:d={end - start}:s={_SAMPLE_RATE}",
            "-af",
            f"aeval=exprs='val(ch)*({gain})':c=same",
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4")


@pytest.mark.parametrize("case", _AUTOMATIC_FIXTURE["cases"], ids=lambda case: case["name"])
def test_render_off_speaker_gain_matches_the_fixture_the_preview_is_tested_against(
    case: dict,
) -> None:
    rendered = _render_unit_automatic(case)
    start = case["clip"]["source_start"]
    for at, expected in case["samples"]:
        index = min(rendered.size - 1, round((at - start) * _SAMPLE_RATE))
        assert rendered[index] == pytest.approx(expected, abs=2e-3), (case["name"], at)
