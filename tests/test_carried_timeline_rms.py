"""A batch applied from the end backward builds the timeline loudness once (#1958)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_proof, verdict_cache
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.cut_proof import CarriedTimelineRms
from podcast_mcp.engines.play_audit import stem_path, write_stem_hash
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
SECONDS = 120


def _project(tmp_path: Path, starts: tuple[float, ...]) -> EpisodeProject:
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    noise = np.random.default_rng(1).normal(0.0, 0.0003, SECONDS * SR)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((noise * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("carried", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=SECONDS, sample_rate=SR, channels=1),
        )
    ]
    project.clips = [
        Clip(id="host", track_id="host", source_start=0, source_end=SECONDS, timeline_start=0)
    ]
    project.timeline.duration_sec = SECONDS
    project.edit_decisions = [_cut(f"c{i}", s, s + 0.4) for i, s in enumerate(starts)]
    return project


@pytest.fixture(autouse=True)
def _short_reach(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verdict_cache, "READ_SEC", 2.0)


def _builds(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    built: list[int] = []
    real = cut_proof.build_track_rms_caches

    def spy(project, **kwargs):
        built.append(len(project.clips))
        return real(project, **kwargs)

    monkeypatch.setattr(cut_proof, "build_track_rms_caches", spy)
    return built


def _approve(project: EpisodeProject) -> list:
    held: list = []
    approve_edits(
        project,
        [e.id for e in project.edit_decisions],
        defaults=load_defaults(),
        held_out=held,
        asked_out=[],
    )
    return held


def _clips(project: EpisodeProject) -> list[tuple[float, float, float]]:
    return [(c.source_start, c.source_end, c.timeline_start) for c in project.clips]


def test_cuts_far_apart_share_one_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _project(tmp_path, (10.0, 40.0, 70.0, 100.0))
    built = _builds(monkeypatch)
    assert _approve(project) == []
    assert len(built) == 1


def test_a_cut_within_reach_of_an_applied_one_builds_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, (10.0, 11.0, 70.0))
    built = _builds(monkeypatch)
    assert _approve(project) == []
    assert len(built) == 2


def test_the_reach_is_the_read_distance_plus_the_fade_reach(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    starts = (10.0, 13.5)
    short = _project(tmp_path / "short", starts)
    built = _builds(monkeypatch)
    assert _approve(short) == []
    assert len(built) == 1

    faded = _project(tmp_path / "faded", starts)
    faded.clips[0].fade_in_ms = 2000
    built.clear()
    assert _approve(faded) == []
    assert len(built) == 2


def test_a_pause_reaches_out_to_the_words_it_is_observed_between(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def project(reason: str) -> EpisodeProject:
        made = _project(tmp_path / reason.replace(":", "_"), (28.0,))
        made.transcripts = [
            Transcript(
                track_id="host",
                words=[
                    TranscriptWord(text="w", start=s, end=s + 0.35)
                    for s in (10.0, 11.0, 12.0, 36.0, 37.0, 38.0)
                ],
            )
        ]
        made.edit_decisions.append(_cut("c1", 20.0, 20.4, reason=reason))
        return made

    built = _builds(monkeypatch)
    _approve(project("nl:range"))
    assert len(built) == 1

    built.clear()
    _approve(project("pause:long"))
    assert len(built) == 2


def test_carrying_decides_the_same_as_building_every_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    starts = (10.0, 11.0, 40.0, 70.0, 71.5, 100.0)
    carried = _project(tmp_path / "carried", starts)
    _approve(carried)

    monkeypatch.setattr(
        CarriedTimelineRms,
        "applied",
        lambda self, timeline_start: setattr(self, "_intact_before", -1.0),
    )
    fresh = _project(tmp_path / "fresh", starts)
    built = _builds(monkeypatch)
    _approve(fresh)

    assert len(built) == len(starts)
    assert _clips(carried) == _clips(fresh)


def _with_a_fresh_guest_stem(project: EpisodeProject) -> None:
    raw = Path(project.workspace_dir) / "raw"
    (raw / "guest.wav").write_bytes((raw / "host.wav").read_bytes())
    guest = Track(
        id="guest",
        label="Guest",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/guest.wav", duration_sec=SECONDS, sample_rate=SR, channels=1),
    )
    project.tracks.append(guest)
    project.clips.append(
        Clip(id="guest", track_id="guest", source_start=0, source_end=SECONDS, timeline_start=0)
    )
    stem = stem_path(project, "guest")
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes((raw / "host.wav").read_bytes())
    write_stem_hash(project, "guest", defaults=load_defaults())


def test_a_stem_gone_stale_after_a_cut_builds_the_loudness_again_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    starts = (10.0, 40.0, 70.0, 100.0)
    carried = _project(tmp_path / "carried", starts)
    _with_a_fresh_guest_stem(carried)
    built = _builds(monkeypatch)
    _approve(carried)
    assert len(built) == 2

    monkeypatch.setattr(
        CarriedTimelineRms,
        "applied",
        lambda self, timeline_start: setattr(self, "_intact_before", -1.0),
    )
    fresh = _project(tmp_path / "fresh", starts)
    _with_a_fresh_guest_stem(fresh)
    _approve(fresh)
    assert _clips(carried) == _clips(fresh)
