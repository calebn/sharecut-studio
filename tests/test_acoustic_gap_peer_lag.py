"""A filler the transcript missed in a long word gap is found, and a peer's bleed is not (#1073).

One track's word gap runs half a minute while the other speaks in it. The acoustic scan
used to skip any gap over about six seconds and to drop a gap whenever a peer sounded
anywhere in it. It now scans a long gap in windows and asks about a peer only where a run
sounds, reading the peer at the pair's measured copy lag: Zoom delivers a remote guest's
track after their voice reaches the host's mic, so at the same instant the guest looks
silent while their voice is on the host's mic.

Each scene plants one voiced "uh" on the guest ("audra") whose copy reaches the host
("caleb") ``copy_delay`` after the guest says it, while the guest's own track carries it
``latency`` later. Reconcile's lag is the difference. Unless a scene says otherwise the "uh" is
shorter than the lag, so at the same instant one track is silent where the other sounds.
"""

from __future__ import annotations

import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from unittest.mock import ANY, patch

import numpy as np
import pytest

from bleed_helpers import DURATION_SEC, RATE, delay, voices, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.peer_copy_lag import PeerCopyLags
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.tighten.acoustic_scan import _add_acoustic_candidates
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_reconciliation_caches
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.io import resolve_project_path
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.util import project_state
from podcast_mcp.util.keyed_lock import KeyedLocks
from podcast_mcp.util.project_state import project_state_lock

QUIET = (99.0, 131.0)
EDGE_WORDS = ((97.0, 98.0), (131.0, 132.0), (132.1, 133.1), (133.2, 134.2))
UH = (128.5, 128.7)
VOICE = 0.2
UH_VOICE = 0.3
PEER_SPEECH = ((103.0, 103.6), (106.0, 106.6), (119.0, 119.6), (125.0, 125.6))
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

    copy_delay: float = 0.0
    latency: float = 0.25
    guest_speech: bool = True
    copy_gain: float = 0.1
    uh_sec: float = 0.2
    gain: float = 1.0
    host_over_uh: tuple[float, float] | None = None
    host_uh: tuple[float, float] | None = None
    host_speech: tuple[tuple[float, float], ...] = field(default=PEER_SPEECH)

    @property
    def own_uh(self) -> tuple[float, float]:
        """Where Audra's own track carries her "uh"."""
        return UH[0] + self.latency, UH[0] + self.uh_sec + self.latency


def _tone(
    start: float, end: float, amplitude: float, hz: float = 150.0, edge: float = 0.25
) -> tuple[int, np.ndarray]:
    first, size = round(start * RATE), round((end - start) * RATE)
    t = np.arange(size) / RATE
    wave_ = sum(np.sin(2 * np.pi * hz * k * t) / k for k in range(1, 6))
    return first, amplitude * wave_ / np.sqrt(np.mean(wave_**2)) * np.hanning(size) ** edge


def _add(
    samples: np.ndarray, start: float, end: float, amplitude: float, hz: float, edge: float = 0.25
) -> None:
    first, tone = _tone(start, end, amplitude, hz, edge)
    samples[first : first + tone.size] += tone


def _audio(scene: Scene) -> dict[str, np.ndarray]:
    dry = voices(7)
    host, guest = dry["caleb"].copy(), dry["audra"].copy()
    for samples in (host, guest):
        samples[round(QUIET[0] * RATE) : round(QUIET[1] * RATE)] = 0.0
    if not scene.guest_speech:
        guest[:] = 0.0
    for samples in (host, guest):
        for start, end in EDGE_WORDS:
            _add(samples, start, end, VOICE, 150.0)
    for start, end in scene.host_speech:
        _add(host, start, end, VOICE, 130.0)
    if scene.host_over_uh is not None:
        _add(host, *scene.host_over_uh, UH_VOICE, 220.0, edge=1.0)
    if scene.host_uh is not None:
        _add(host, *scene.host_uh, UH_VOICE, 220.0, edge=1.0)
    _add(guest, UH[0], UH[0] + scene.uh_sec, UH_VOICE, 220.0, edge=1.0)
    noise = np.random.default_rng(11).standard_normal((2, host.size))
    return {
        "caleb": scene.gain
        * (host + scene.copy_gain * delay(guest, scene.copy_delay) + 1e-4 * noise[0]),
        "audra": scene.gain * delay(guest + 1e-4 * noise[1], scene.latency),
    }


def _project(tmp_path: Path, scene: Scene, *, owner: str) -> EpisodeProject:
    """Only ``owner`` has words, so only it has a word gap to scan."""
    project = EpisodeProject.create("peer-lag", str(tmp_path))
    lag = {"caleb": 0.0, "audra": scene.latency}

    def edge_words(track_id: str) -> list[TranscriptWord]:
        return [
            TranscriptWord(text=text, start=start + lag[track_id], end=end + lag[track_id])
            for text, (start, end) in zip(("so", "right", "yeah", "okay"), EDGE_WORDS, strict=True)
        ]

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
        project.transcripts.append(
            Transcript(track_id=track_id, words=edge_words(track_id) if track_id == owner else [])
        )
    return project


def _candidates(
    project: EpisodeProject, owner: str
) -> tuple[list[tuple[float, float]], dict[str, int]]:
    """The acoustic filler candidates on ``owner`` and what the scan skipped."""
    caches = build_track_audio_caches(project, ["caleb", "audra"])
    skips: dict[str, int] = {}
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        found = _add_acoustic_candidates(
            [],
            project.transcript_for_track(owner),
            {"tighten": {}},
            project=project,
            audio_cache=caches[owner],
            audio_caches=caches,
            copy_lags=PeerCopyLags(project),
            skip_counts=skips,
        )
    return [(c.start, c.end) for c in found if c.reason == "filler:acoustic"], skips


def _proposed(project: EpisodeProject, owner: str) -> list[tuple[float, float]]:
    """The same through the public proposal, in mute mode."""
    defaults = {"tighten": {"edit_mode": "mute", "filler_words": ["uh"], "discourse_markers": []}}
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        proposal = propose_tighten_edits(project, defaults, intensity="medium")
    return [
        (d.start, d.end)
        for d in proposal.decisions
        if d.track_id == owner and d.reason.startswith("filler:acoustic")
    ]


def _covers(spans: list[tuple[float, float]], target: tuple[float, float]) -> bool:
    return len(spans) == 1 and spans[0][0] <= target[0] + 0.05 and spans[0][1] >= target[1] - 0.05


LAG_SCENES = pytest.mark.parametrize(
    "scene",
    [
        pytest.param(Scene(copy_delay=0.0, latency=0.25), id="track-trails-its-copy"),
        pytest.param(Scene(copy_delay=0.25, latency=0.0), id="track-leads-its-copy"),
        pytest.param(Scene(copy_delay=0.0, latency=0.0), id="no-lag"),
    ],
)


@LAG_SCENES
def test_a_missed_filler_in_a_half_minute_gap_is_found_while_the_peer_speaks_in_it(
    tmp_path: Path, scene: Scene
) -> None:
    project = _project(tmp_path, scene, owner="audra")

    spans, skips = _candidates(project, "audra")

    assert _covers(spans, scene.own_uh)
    assert skips.get("acoustic:peer_speaking", 0) == 0
    assert _covers(_proposed(project, "audra"), scene.own_uh)


@pytest.mark.parametrize("gain", [0.1, 4.0])
def test_the_finding_does_not_depend_on_the_recording_level(tmp_path: Path, gain: float) -> None:
    scene = Scene(gain=gain)

    spans, _ = _candidates(_project(tmp_path, scene, owner="audra"), "audra")

    assert _covers(spans, scene.own_uh)


@pytest.mark.parametrize(
    "scene",
    [
        pytest.param(Scene(copy_delay=0.0, latency=0.25), id="track-trails-its-copy"),
        pytest.param(Scene(copy_delay=0.25, latency=0.0), id="track-leads-its-copy"),
    ],
)
def test_the_hosts_copy_of_the_guests_filler_is_read_against_the_guest_at_the_lag(
    tmp_path: Path, scene: Scene
) -> None:
    """The copy is 8 dB under the filler. At one instant only half the filler overlaps it, which is 5 dB over."""
    scene = replace(scene, copy_gain=0.4, uh_sec=0.5)
    project = _project(tmp_path, scene, owner="audra")

    spans, skips = _candidates(project, "audra")

    assert _covers(spans, scene.own_uh)
    assert skips.get("acoustic:peer_speaking", 0) == 0


def test_the_peer_speaking_over_the_filler_at_the_same_pitch_still_blocks_it(
    tmp_path: Path,
) -> None:
    own = Scene().own_uh
    scene = Scene(host_over_uh=(own[0] - 0.02, own[1] + 0.02))

    spans, skips = _candidates(_project(tmp_path, scene, owner="audra"), "audra")

    assert spans == []
    assert skips["acoustic:peer_speaking"] == 1


HOST_UH = (126.5, 126.7)


@LAG_SCENES
def test_the_guests_voice_on_the_hosts_mic_is_not_the_hosts_filler(
    tmp_path: Path, scene: Scene
) -> None:
    scene = replace(scene, copy_gain=0.5, host_speech=(), host_uh=HOST_UH)
    project = _project(tmp_path, scene, owner="caleb")

    spans, skips = _candidates(project, "caleb")

    assert _covers(spans, HOST_UH)
    assert skips["acoustic:peer_speaking"] == 1
    assert _covers(_proposed(project, "caleb"), HOST_UH)


@pytest.mark.parametrize(
    "scene",
    [
        pytest.param(Scene(copy_delay=0.0, latency=0.45), id="lag-beyond-the-search"),
        pytest.param(
            Scene(copy_delay=0.0, latency=0.25, guest_speech=False), id="too-little-guest"
        ),
    ],
)
def test_an_unmeasured_lag_reads_the_guest_at_the_same_instant(
    tmp_path: Path, scene: Scene
) -> None:
    """With no confident lag the guest is read at 0 lag, so the host's mic carries a filler the guest's track lacks."""
    scene = replace(scene, copy_gain=0.5, host_speech=(), host_uh=HOST_UH)
    project = _project(tmp_path, scene, owner="caleb")

    spans, skips = _candidates(project, "caleb")

    assert len(spans) == 2
    assert skips.get("acoustic:peer_speaking", 0) == 0


def test_the_lag_is_the_one_reconcile_measures_and_is_zero_off_a_measured_path(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, Scene(copy_delay=0.0, latency=0.25), owner="audra")
    lags = PeerCopyLags(project)

    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        assert lags.sec("audra", "caleb", defaults=load_defaults()) == pytest.approx(0.25, abs=0.02)
        assert lags.sec("caleb", "audra", defaults=load_defaults()) == 0.0
        assert lags.sec("audra", "lana", defaults=load_defaults()) == 0.0


def test_a_gated_track_is_measured_before_its_transcript_gate(tmp_path: Path) -> None:
    project = _project(tmp_path, Scene(), owner="audra")
    project.tracks[0].transcript_gate = True

    with patch("podcast_mcp.engines.audio_audit.build_track_rms_caches") as build:
        build_reconciliation_caches(project, defaults=load_defaults())

    build.assert_called_once_with(
        project,
        before_transcript_gate=True,
        private_copy=False,
        unprocessed=True,
        defaults=ANY,
    )


def test_a_worker_inside_a_mutation_measures_a_gated_track_without_the_project_lock(
    tmp_path: Path,
) -> None:
    """Tighten gathers candidates on pool threads while the mutating thread holds the project
    lock; a gated track's pre-gate render must not wait for that lock (#1471)."""
    project = _project(tmp_path, Scene(), owner="audra")
    project.tracks[0].transcript_gate = True

    def render_raw(snapshot, track, path, _defaults):
        shutil.copy(tmp_path / "raw" / f"{track.id}.wav", path)

    with (
        patch("podcast_mcp.engines.timeline_render.render_track_from_timeline", render_raw),
        patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]),
        ThreadPoolExecutor(max_workers=1) as pool,
        project_state_lock(project),
    ):
        lags = PeerCopyLags(project)
        lag = pool.submit(lags.sec, "audra", "caleb", defaults=load_defaults()).result(timeout=30)

    assert lag == pytest.approx(0.25, abs=0.02)


class _BoundedRLock:
    """The project lock, except that a wait over ``LOCK_WAIT_SEC`` is recorded and raised, not endless."""

    LOCK_WAIT_SEC = 10

    def __init__(self, stalled: list[str]) -> None:
        self._lock = threading.RLock()
        self._stalled = stalled

    def __enter__(self) -> None:
        if not self._lock.acquire(timeout=self.LOCK_WAIT_SEC):
            self._stalled.append(threading.current_thread().name)
            raise TimeoutError("waited on the project lock held by the mutating thread")

    def __exit__(self, *_exc: object) -> None:
        self._lock.release()


def test_proposing_inside_a_mutation_finishes_on_a_project_with_active_effects_chains(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pool worker measuring the copy lag reads the chained tracks' evidence while the mutating
    thread holds the project lock; it must not wait for that lock (#2214)."""
    stalled: list[str] = []
    monkeypatch.setattr(project_state, "_locks", KeyedLocks(lambda: _BoundedRLock(stalled)))
    project = _project(tmp_path, Scene(), owner="audra")
    project.processing_chains = [
        ProcessingChain(
            track_id=track.id,
            effects=[
                ProcessingEffect(effect="acompressor", params={"threshold_db": -24, "ratio": 4})
            ],
        )
        for track in project.tracks
    ]
    path = resolve_project_path(tmp_path)
    ProjectStore(path).commit(project)
    workspace = ProjectWorkspace.open(path)
    defaults = {"tighten": {"edit_mode": "mute", "filler_words": ["uh"], "discourse_markers": []}}
    outcome: list[object] = []

    def propose(live: EpisodeProject) -> None:
        with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
            outcome.append(propose_tighten_edits(live, defaults, intensity="aggressive"))

    def mutate() -> None:
        try:
            workspace.mutate("before propose", "after propose", propose)
        except BaseException as exc:
            outcome.append(exc)

    runner = threading.Thread(target=mutate, daemon=True)
    runner.start()
    runner.join(timeout=120)

    assert not runner.is_alive()
    assert stalled == []
    assert [type(item).__name__ for item in outcome] == ["TightenProposal"]
