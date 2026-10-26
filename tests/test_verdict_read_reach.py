"""A check reads no further from its cut than the verdict key's window (#2356)."""

from __future__ import annotations

import itertools
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_quality, verdict_cache
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.engines import align
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from source_review_helpers import _cut

SR = 16_000
SECONDS = 80
CUT = (40.0, 40.4)


def _write(path: Path, seed: int, bursts: tuple[tuple[float, float], ...]) -> None:
    rng = np.random.default_rng(seed)
    audio = rng.normal(0.0, 0.0003, SECONDS * SR)
    for start, end in bursts:
        t = np.arange(round((end - start) * SR)) / SR
        audio[round(start * SR) : round(end * SR)] += (
            0.2 * np.sin(2 * np.pi * 180 * t) * rng.uniform(0.5, 1.0, t.size)
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((audio * 32767).astype("<i2").tobytes())


def _words(starts: list[float]) -> list[TranscriptWord]:
    return [TranscriptWord(text=f"w{i}", start=s, end=s + 0.35) for i, s in enumerate(starts)]


def _project(tmp_path: Path, reason: str) -> EpisodeProject:
    host_starts = [float(s) for s in range(30, 52, 1)]
    guest_starts = [33.0, 36.5, 39.8, 41.0, 44.2, 47.0]
    _write(tmp_path / "raw" / "host.wav", 1, tuple((s, s + 0.35) for s in host_starts))
    _write(tmp_path / "raw" / "guest.wav", 2, tuple((s, s + 0.35) for s in guest_starts))
    project = EpisodeProject.create("read reach", str(tmp_path))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(
                path=f"raw/{tid}.wav", duration_sec=SECONDS, sample_rate=SR, channels=1
            ),
        )
        for tid in ("host", "guest")
    ]
    edges = [0.0, 34.0, 38.0, 43.0, 47.0, 60.0, float(SECONDS)]
    project.clips = [
        Clip(
            id=f"{tid}{i}",
            track_id=tid,
            source_start=a,
            source_end=b,
            timeline_start=a,
            fade_in_ms=[0, 250, 40, 300, 20, 120][i],
            fade_out_ms=[250, 40, 300, 20, 120, 0][i],
        )
        for tid in ("host", "guest")
        for i, (a, b) in enumerate(itertools.pairwise(edges))
    ]
    project.transcripts = [
        Transcript(track_id="host", words=_words(host_starts)),
        Transcript(track_id="guest", words=_words(guest_starts)),
    ]
    project.transcripts[0].words[10].text = "um"
    project.timeline.duration_sec = SECONDS
    project.edit_decisions = [_cut("cut", *CUT, reason=reason)]
    return project


def _spy_reads(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, float, float]]:
    reads: list[tuple[str, float, float]] = []
    real_window = TrackRmsCache.window
    real_disk = align.load_mono_window

    def window(self, t_start, t_end):
        reads.append(("window", float(t_start), float(t_end)))
        return real_window(self, t_start, t_end)

    def disk(path, *, start_sec, duration_sec, **kwargs):
        reads.append(("disk", float(start_sec), float(start_sec + duration_sec)))
        return real_disk(path, start_sec=start_sec, duration_sec=duration_sec, **kwargs)

    monkeypatch.setattr(TrackRmsCache, "window", window)
    for module in list(sys.modules.values()):
        if getattr(module, "load_mono_window", None) is real_disk:
            monkeypatch.setattr(module, "load_mono_window", disk)
    return reads


@pytest.mark.parametrize("reason", ["nl:range", "filler:um"])
def test_a_check_reads_no_further_than_the_window_around_its_cut(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    project = _project(tmp_path, reason)
    defaults = load_defaults()
    reach = verdict_cache.READ_SEC + cut_quality.fade_reach_sec(
        project, project.edit_decisions[0], defaults
    )
    reads = _spy_reads(monkeypatch)
    approve_edits(project, ["cut"], defaults=defaults, held_out=[], asked_out=[])
    assert len(reads) > 5
    outside = [r for r in reads if r[1] < CUT[0] - reach or r[2] > CUT[1] + reach]
    assert outside == []
