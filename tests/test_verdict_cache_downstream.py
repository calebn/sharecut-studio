"""A cached verdict equals a cold check when a clip far downstream of the cut changes its ramp (#2365)."""

from __future__ import annotations

import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import verdict_cache
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

SR, DUR, CUT = 16_000, 120, 43.041


def _project(root: Path, mutate: Callable[[list[Clip]], None]) -> EpisodeProject:
    rng = np.random.default_rng(1)
    audio = rng.normal(0.0, 0.0003, DUR * SR)
    words = []
    for i, t in enumerate(np.arange(5.0, DUR - 5, 0.9)):
        t = round(float(t), 3)
        if abs(t - CUT) < 0.5:
            t = CUT
        words.append(
            TranscriptWord(text="um" if t == CUT else f"w{i}", start=t, end=round(t + 0.35, 3))
        )
        if t != CUT:
            n = round(0.35 * SR)
            audio[round(t * SR) : round(t * SR) + n] += 0.2 * np.sin(
                2 * np.pi * 180 * np.arange(n) / SR
            )
    path = root / "raw" / "host.wav"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(SR)
            handle.writeframes((audio * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("downstream", str(root))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=DUR, sample_rate=SR, channels=1),
        )
    ]
    project.clips = [
        Clip(
            id=f"h{i}",
            track_id="host",
            source_start=a,
            source_end=b,
            timeline_start=a,
            fade_in_ms=fi,
            fade_out_ms=fo,
        )
        for i, (a, b, fi, fo) in enumerate(
            [
                (0, 29.88, 1000, 10),
                (29.88, 51.49, 10, 50),
                (51.49, 91.11, 50, 0),
                (91.11, 120, 0, 0),
            ]
        )
    ]
    mutate(project.clips)
    project.transcripts = [Transcript(track_id="host", words=words)]
    project.timeline.duration_sec = DUR
    project.edit_decisions = [
        EditDecision(
            id="e",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=CUT,
            end=round(CUT + 0.35, 3),
            reason="filler:um",
            applied=False,
            boundary_mode="vocal_transcript_guided",
        )
    ]
    return project


def _outcome(project: EpisodeProject) -> tuple[int, list[str]]:
    held: list = []
    applied = approve_edits(project, ["e"], defaults=load_defaults(), held_out=held, asked_out=[])
    return applied, [h.reason for h in held]


def _set(index: int, field: str, ms: int) -> Callable[[list[Clip]], None]:
    return lambda clips: setattr(clips[index], field, ms)


# Clips 2 and 3 lie past the window; clip 1 straddles both of its edges.
@pytest.mark.parametrize(
    "change",
    [
        pytest.param(_set(2, "fade_out_ms", 1000), id="far_fade_out"),
        pytest.param(_set(3, "fade_in_ms", 1000), id="far_fade_in"),
        pytest.param(_set(1, "fade_out_ms", 900), id="straddler_fade_out"),
        pytest.param(_set(1, "fade_in_ms", 900), id="straddler_fade_in"),
    ],
)
def test_a_cached_verdict_equals_a_cold_check_when_a_clip_ramp_outside_the_window_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: Callable[[list[Clip]], None]
) -> None:
    hits: list[bool] = []
    lookup = verdict_cache.lookup

    def spy(key: str | None) -> Any:
        found = lookup(key)
        hits.extend([True] if found else [])
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold = _outcome(_project(tmp_path, change))
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    _outcome(_project(tmp_path, lambda clips: None))
    assert not hits
    _outcome(_project(tmp_path, lambda clips: None))
    assert hits, "the unchanged project must hit the cache"
    assert _outcome(_project(tmp_path, change)) == cold
