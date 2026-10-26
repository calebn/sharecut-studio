"""A check reads no further from its cut than the verdict key's window (#2356).

Reads made while scanning a whole recording (its room level, its first and last word) are
left out: the key covers them by the recording's file revision, not by the window.
"""

from __future__ import annotations

import itertools
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import session_air, verdict_cache
from podcast_mcp.edits.audio_cache import BandLevels
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


def _project(tmp_path: Path, reason: str, host_starts: list[float] | None = None) -> EpisodeProject:
    host_starts = host_starts or [float(s) for s in range(30, 52, 1)]
    guest_starts = (
        [36.0, 44.0, 46.0] if reason.startswith("pause:") else [33.0, 36.5, 39.8, 41.0, 44.2, 47.0]
    )
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
    edges = [0.0, 34.0, 38.0, 43.0, 47.0, 70.0, float(SECONDS)]
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
    if reason.startswith("filler:"):
        project.transcripts[0].words[10].text = "um"
    project.timeline.duration_sec = SECONDS
    project.edit_decisions = [_cut("cut", *CUT, reason=reason)]
    return project


def _spy_reads(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, float, float]]:
    reads: list[tuple[str, float, float]] = []
    real_window = TrackRmsCache.window
    real_disk = align.load_mono_window
    scanning = [0]

    def whole_recording(real):
        def wrapped(*args, **kwargs):
            scanning[0] += 1
            try:
                return real(*args, **kwargs)
            finally:
                scanning[0] -= 1

        return wrapped

    def window(self, t_start, t_end):
        if not scanning[0]:
            reads.append(("window", float(t_start), float(t_end)))
        return real_window(self, t_start, t_end)

    def disk(path, *, start_sec, duration_sec, **kwargs):
        if not scanning[0]:
            reads.append(("disk", float(start_sec), float(start_sec + duration_sec)))
        return real_disk(path, start_sec=start_sec, duration_sec=duration_sec, **kwargs)

    monkeypatch.setattr(TrackRmsCache, "window", window)
    for owner, name in (
        (BandLevels, "all_levels"),
        (session_air._Recording, "reading"),
        (session_air._Recording, "content_span"),
    ):
        monkeypatch.setattr(owner, name, whole_recording(getattr(owner, name)))
    for module in list(sys.modules.values()):
        if getattr(module, "load_mono_window", None) is real_disk:
            monkeypatch.setattr(module, "load_mono_window", disk)
    return reads


LONG_SILENCE = [30.0, 31.0, 32.0, 48.0, 49.0, 50.0]


@pytest.mark.parametrize(
    ("reason", "host_starts"),
    [("nl:range", None), ("filler:um", None), ("pause:long", LONG_SILENCE)],
)
def test_a_check_reads_no_further_than_the_window_around_its_cut(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reason: str,
    host_starts: list[float] | None,
) -> None:
    project = _project(tmp_path, reason, host_starts)
    defaults = load_defaults()
    reach = verdict_cache.check_reach_sec(project, project.edit_decisions[0], CUT, defaults)
    reads = _spy_reads(monkeypatch)
    approve_edits(project, ["cut"], defaults=defaults, held_out=[], asked_out=[])
    assert len(reads) > 5
    outside = [r for r in reads if r[1] < CUT[0] - reach or r[2] > CUT[1] + reach]
    assert outside == []


def test_a_pause_in_a_long_silence_widens_the_window_to_the_words_it_observes(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, "pause:long", LONG_SILENCE)
    edit = project.edit_decisions[0]
    defaults = load_defaults()
    plain = _project(tmp_path / "plain", "nl:range", LONG_SILENCE).edit_decisions[0]
    assert verdict_cache.check_reach_sec(project, plain, CUT, defaults) < 6.5
    assert verdict_cache.check_reach_sec(project, edit, CUT, defaults) > 13.0


def test_a_clip_boundary_inside_the_observed_words_of_a_pause_changes_its_key(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, "pause:long", LONG_SILENCE)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": CUT}
    guest = Clip(id="guest", track_id="guest", source_start=0, source_end=SECONDS, timeline_start=0)

    def key(*host_edges: float) -> str | None:
        edges = [0.0, *host_edges, float(SECONDS)]
        project.clips = [
            Clip(id=f"h{i}", track_id="host", source_start=a, source_end=b, timeline_start=a)
            for i, (a, b) in enumerate(itertools.pairwise(edges))
        ] + [guest]
        return verdict_cache.verdict_key(project, edit, **kwargs)

    base = key()
    assert base is not None
    assert key(47.0) != base
    assert key(55.0) == base
