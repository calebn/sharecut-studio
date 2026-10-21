"""Tighten does not propose a lagged peer's bleed as the host's own filler (#1072).

Zoom delivers a remote guest's track after their voice reaches the host's mic. A filler the
guest says leaves a quiet copy on the host's track while the guest's own track is still
silent, so a check that reads both tracks at the same instant calls the copy the host's
own word. Reconcile reads the guest at the pair's measured copy lag instead, and tighten
takes whose word it is from that verdict. Each scene plants one guest "uh" and one host
"uh", with the guest's own track a different lag behind its copy, then runs reconcile and
tighten. The guest's "uh" is shorter than every lag, so at 0 lag the guest's track is
silent while the word is on the host's mic.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from bleed_helpers import RATE, delay, voices, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    CopyPath,
    TrackRmsCacheSet,
    build_track_rms_caches,
    compute_word_audibility_map,
)
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

DURATION_SEC = 240.0
COPY_GAIN = 0.1
VOICE = 0.2
QUIET = (100.0, 130.0)
HOST_UH = (107.0, 107.3)
GUEST_UH = (110.0, 110.2)
BLEED_PATH = EchoPairProfile(
    source_track_id="audra",
    bleed_track_id="caleb",
    span_start=0.0,
    span_end=DURATION_SEC,
    dominated_frames=100,
    copy_frames=40,
    consistent_frames=30,
    lag_ms=0.5,
    level_db=-20.0,
    examples=(1.0,),
    null_runs=8,
    null_copy_rate=0.05,
    null_consistent_rate=0.02,
)


@dataclass(frozen=True)
class Scene:
    """Caleb's mic carries Audra ``copy_delay`` after she speaks; her own track, ``latency``."""

    copy_delay: float
    latency: float
    guest_speech: bool = True

    @property
    def copy_at(self) -> tuple[float, float]:
        return GUEST_UH[0] + self.copy_delay, GUEST_UH[1] + self.copy_delay

    @property
    def host_words(self) -> list[tuple[str, float, float]]:
        return [
            ("so", 105.0, 105.3),
            ("uh", *HOST_UH),
            ("right", 107.5, 108.0),
            ("yeah", 109.4, 109.8),
            ("uh", *self.copy_at),
            ("right", 111.0, 111.4),
        ]


def _tone(start: float, end: float, amplitude: float) -> tuple[int, np.ndarray]:
    first, size = round(start * RATE), round((end - start) * RATE)
    t = np.arange(size) / RATE
    wave_ = sum(np.sin(2 * np.pi * 150.0 * k * t) / k for k in range(1, 6))
    return first, amplitude * wave_ / np.sqrt(np.mean(wave_**2)) * np.hanning(size) ** 0.25


def _audio(scene: Scene) -> dict[str, np.ndarray]:
    dry = voices(7)
    host, guest = dry["caleb"].copy(), dry["audra"].copy()
    for samples in (host, guest):
        samples[round(QUIET[0] * RATE) : round(QUIET[1] * RATE)] = 0.0
    if not scene.guest_speech:
        guest[:] = 0.0
    for start, end in ((105.0, 105.3), HOST_UH, (107.5, 108.0), (109.4, 109.8), (111.0, 111.4)):
        first, tone = _tone(start, end, VOICE)
        host[first : first + tone.size] += tone
    first, size = round(GUEST_UH[0] * RATE), round((GUEST_UH[1] - GUEST_UH[0]) * RATE)
    burst = np.random.default_rng(5).standard_normal(size) * np.hanning(size)
    guest[first : first + size] += 0.3 * burst
    noise = np.random.default_rng(11).standard_normal((2, host.size))
    return {
        "caleb": host + COPY_GAIN * delay(guest, scene.copy_delay) + 1e-4 * noise[0],
        "audra": delay(guest + 1e-4 * noise[1], scene.latency),
    }


def _project(tmp_path: Path, scene: Scene) -> EpisodeProject:
    project = EpisodeProject.create("lagged-bleed", str(tmp_path))
    own_uh = (GUEST_UH[0] + scene.latency, GUEST_UH[1] + scene.latency)
    words = {
        "caleb": [TranscriptWord(text=t, start=s, end=e) for t, s, e in scene.host_words],
        "audra": [TranscriptWord(text="uh", start=own_uh[0], end=own_uh[1])],
    }
    for track_id, samples in _audio(scene).items():
        write_wav(tmp_path / "raw" / f"{track_id}.wav", samples)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                speaker=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=DURATION_SEC),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=DURATION_SEC,
                timeline_start=0.0,
            )
        )
        project.transcripts.append(Transcript(track_id=track_id, words=words[track_id]))
    return project


def _reconcile(project: EpisodeProject, *, lag_known: bool = True) -> dict[float, str]:
    """Reconcile's verdict on each of Caleb's words, written onto the transcript as it does."""
    caches = build_track_rms_caches(project, defaults=load_defaults())
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        if lag_known:
            rows = compute_word_audibility_map(
                project, policy=AnalysisPolicy(), caches=caches, defaults=load_defaults()
            )
        else:
            with patch.object(TrackRmsCacheSet, "copy_path", lambda self, a, b: CopyPath()):
                rows = compute_word_audibility_map(
                    project, policy=AnalysisPolicy(), caches=caches, defaults=load_defaults()
                )
    verdicts = {}
    for row in rows:
        word = project.transcript_for_track(row["track_id"]).words[row["word_index"]]
        word.audibility_status = row["audibility_status"]
        word.dominant_track = row["dominant_track"]
        if row["track_id"] == "caleb":
            verdicts[word.start] = row["audibility_status"]
    return verdicts


def _proposed_fillers(project: EpisodeProject, edit_mode: str) -> list[int]:
    """Whole seconds at which tighten proposes a filler on Caleb's track."""
    defaults = {
        "tighten": {
            "edit_mode": edit_mode,
            "filler_words": ["uh"],
            "discourse_markers": [],
            "acoustic_gap": {"enabled": False},
        }
    }
    proposal = propose_tighten_edits(project, defaults, intensity="medium")
    return sorted(
        round(d.start)
        for d in proposal.decisions
        if d.track_id == "caleb" and d.reason.startswith("filler:uh")
    )


HOST_UH_AT, GUEST_UH_AT = round(HOST_UH[0]), round(GUEST_UH[0])
LAGGED = Scene(copy_delay=0.0, latency=0.25)


def test_without_the_lag_the_guests_copy_is_proposed_as_the_hosts_filler(tmp_path: Path) -> None:
    """The scene is sensitive: read at the same instant, the copy is the host's own word."""
    project = _project(tmp_path, LAGGED)
    verdicts = _reconcile(project, lag_known=False)
    assert verdicts[LAGGED.copy_at[0]] == "audible"
    assert _proposed_fillers(project, "mute") == [HOST_UH_AT, GUEST_UH_AT]


@pytest.mark.parametrize("edit_mode", ["mute", "ripple"])
@pytest.mark.parametrize(
    "scene",
    [
        pytest.param(LAGGED, id="guest-track-trails-its-copy"),
        pytest.param(Scene(copy_delay=0.25, latency=0.0), id="guest-track-leads-its-copy"),
        pytest.param(Scene(copy_delay=0.0, latency=0.0), id="no-lag"),
    ],
)
def test_a_lagged_copy_is_not_the_hosts_filler(
    tmp_path: Path, edit_mode: str, scene: Scene
) -> None:
    project = _project(tmp_path, scene)
    verdicts = _reconcile(project)
    assert verdicts[scene.copy_at[0]] == "bleed"
    assert verdicts[HOST_UH[0]] == "audible"
    assert _proposed_fillers(project, edit_mode) == [HOST_UH_AT]


@pytest.mark.parametrize(
    "scene",
    [
        pytest.param(Scene(copy_delay=0.0, latency=0.45), id="lag-beyond-the-search"),
        pytest.param(
            Scene(copy_delay=0.0, latency=0.25, guest_speech=False), id="too-little-guest"
        ),
    ],
)
def test_an_unmeasured_lag_keeps_the_same_instant_verdict(tmp_path: Path, scene: Scene) -> None:
    """Without a confident lag the guest is read at 0 lag, as before the lag was measured."""
    project = _project(tmp_path, scene)
    caches = build_track_rms_caches(project, defaults=load_defaults())
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        assert caches.copy_path("audra", "caleb") == CopyPath()
    assert _reconcile(project)[scene.copy_at[0]] == "audible"
