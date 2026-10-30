"""``_project_pad_lane`` reads the project's clips and never writes them (#2359).

The lane may hold the project's own ``Clip`` objects. Its callers (``bind_pause_effects``,
``room_tone_pad``) only read them; these tests pin that, and that the lane equals what a
deep-copied input gives.
"""

from __future__ import annotations

import random
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import timeline_ops
from podcast_mcp.edits.ripple import RippleRemoval
from podcast_mcp.edits.session_air import GeometricPause
from podcast_mcp.edits.timeline_ops import (
    LaneUnavailable,
    _project_pad_lane,
    bind_pause_effects,
    room_tone_pad,
)
from podcast_mcp.engines import room_tone_synth
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.room_tone import OwnQuietSample, Sample
from podcast_mcp.models import (
    Clip,
    ClipBleedRestore,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)
from podcast_mcp.models.episode import SourceSpan

DEFAULTS = load_defaults()
SECONDS = 60
RATE = 8000
TRACKS = ("host", "guest")


def _clip_json(project: EpisodeProject) -> list[str]:
    return [c.model_dump_json() for c in project.clips]


def _project_json(project: EpisodeProject) -> str:
    return project.model_dump_json()


def _random_clip(rng: random.Random, tid: str, index: int, timeline: float) -> Clip:
    length = rng.uniform(0.5, 6.0)
    source = rng.uniform(0.0, 40.0)
    mutes = [
        ClipMuteRegion(start_s=source + a, end_s=source + a + rng.uniform(0.05, 0.4))
        for a in sorted(rng.uniform(0.0, max(length - 0.5, 0.1)) for _ in range(rng.randint(0, 3)))
    ]
    off = [
        ClipOffSpeakerMuteRegion(start_s=source + a, end_s=source + a + rng.uniform(0.05, 0.3))
        for a in (rng.uniform(0.0, max(length - 0.4, 0.1)) for _ in range(rng.randint(0, 2)))
    ]
    restore = (
        ClipBleedRestore(
            source_sha256="a" * 64,
            regions=[SourceSpan(start_s=source + 0.1, end_s=source + 0.3)],
        )
        if rng.random() < 0.4
        else None
    )
    return Clip(
        id=f"{tid}{index}",
        track_id=tid,
        source_start=source,
        source_end=source + length,
        timeline_start=timeline,
        fade_in_ms=rng.choice((0, 10, 30)),
        fade_out_ms=rng.choice((0, 10, 30)),
        mute_regions=mutes,
        off_speaker_mute_regions=off,
        bleed_restore=restore,
    )


def _write_wav(path: Path, seed: int) -> None:
    noise = np.random.default_rng(seed).normal(0.0, 0.02, SECONDS * RATE)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes((noise * 32767).astype("<i2").tobytes())


def _project(tmp_path: Path, seed: int) -> EpisodeProject:
    rng = random.Random(seed)
    project = EpisodeProject.create("pad", str(tmp_path))
    project.tracks = []
    for tid in TRACKS:
        raw = tmp_path / "raw" / f"{tid}.wav"
        raw.parent.mkdir(parents=True, exist_ok=True)
        _write_wav(raw, seed + len(project.tracks))
        project.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=SECONDS),
            )
        )
    clips: list[Clip] = []
    for tid in TRACKS:
        t = 0.0
        for i in range(rng.randint(4, 9)):
            clip = _random_clip(rng, tid, i, t)
            clips.append(clip)
            t = clip.timeline_end + rng.choice((0.0, 0.0, 1e-9, 0.3))
    project.clips = clips
    return project


def _removal(rng: random.Random, project: EpisodeProject) -> RippleRemoval | None:
    if rng.random() < 0.3:
        return None
    end = max(c.timeline_end for c in project.clips)
    spans: list[tuple[float, float]] = []
    cursor = 0.0
    for _ in range(rng.randint(1, 3)):
        start = rng.uniform(cursor, max(end - 1.0, cursor + 0.1))
        stop = start + rng.uniform(0.05, 1.5)
        spans.append((start, stop))
        cursor = stop + 0.01
    return RippleRemoval.of(unselected=spans)


def _at_time(rng: random.Random, project: EpisodeProject, removal: RippleRemoval | None) -> float:
    if removal is not None:
        return removal.spans[0][0]
    # inside a clip (the split branch) or on an edge
    clip = rng.choice(project.clips)
    return rng.choice(((clip.timeline_start + clip.timeline_end) / 2, clip.timeline_end))


def _scenario(
    tmp_path: Path, seed: int, base: int
) -> tuple[EpisodeProject, RippleRemoval | None, float]:
    """A random project, an optional removal and the time a pad is bound at."""
    rng = random.Random(base + seed)
    project = _project(tmp_path, seed)
    removal = _removal(rng, project)
    return project, removal, _at_time(rng, project, removal)


def _old_lane_clips(project: EpisodeProject, tid: str) -> list[Clip]:
    return [c.model_copy(deep=True) for c in clips_for_track(project, tid)]


def _dump(clips: object) -> object:
    if isinstance(clips, list):
        return [c.model_dump(exclude={"id"}) for c in clips]
    return clips


@pytest.mark.parametrize("seed", range(40))
def test_the_lane_is_what_the_deep_copying_version_returned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: int
) -> None:
    project, removal, at_time = _scenario(tmp_path, seed, 1000)
    new = {t: _project_pad_lane(project, t, at_time, removal, defaults=DEFAULTS) for t in TRACKS}
    monkeypatch.setattr(timeline_ops, "clips_for_track", _old_lane_clips)
    old = {t: _project_pad_lane(project, t, at_time, removal, defaults=DEFAULTS) for t in TRACKS}
    for tid in TRACKS:
        assert _dump(new[tid]) == _dump(old[tid])


@pytest.mark.parametrize("seed", range(40))
def test_the_lane_leaves_every_project_clip_as_it_was(tmp_path: Path, seed: int) -> None:
    project, removal, at_time = _scenario(tmp_path, seed, 2000)
    before = _project_json(project)
    ids = [id(c) for c in project.clips]
    for tid in TRACKS:
        _project_pad_lane(project, tid, at_time, removal, defaults=DEFAULTS)
    assert _project_json(project) == before
    assert [id(c) for c in project.clips] == ids


@pytest.mark.parametrize("seed", range(40))
def test_the_callers_leave_the_project_as_it_was_and_answer_as_before(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: int
) -> None:
    project, removal, at_time = _scenario(tmp_path, seed, 3000)
    before = _clip_json(project)

    def stub(
        _project_arg,
        _tid,
        *,
        near_sec,
        near_source_id,
        timeline_sec,
        duration_sec,
        avoid,
        also_taken,
    ):  # type: ignore[no-untyped-def]
        """The seam a lane binds, as a sample: its source edge, source id and the pad's size."""
        return OwnQuietSample(
            Sample(
                near_sec, near_sec + duration_sec, timeline_sec, float(len(near_source_id or ""))
            )
        )

    monkeypatch.setattr(room_tone_synth, "room_tone_span", stub)

    def call() -> tuple[object, object]:
        pad = room_tone_pad(project, at_time, 0.25, defaults=DEFAULTS)
        bound = (
            bind_pause_effects(
                project,
                at_time,
                removal,
                observation=GeometricPause(activity=()),
                splice_fade_ms=20,
                defaults=DEFAULTS,
            )
            if removal is not None
            else None
        )
        return pad, bound

    new = call()
    assert _clip_json(project) == before
    monkeypatch.setattr(timeline_ops, "clips_for_track", _old_lane_clips)
    old = call()
    assert _clip_json(project) == before
    assert new == old


@pytest.mark.parametrize("seed", range(10))
def test_binding_effects_at_a_clip_edge_leaves_the_shared_clip_as_it_was(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: int
) -> None:
    project = _project(tmp_path, seed)
    edge = clips_for_track(project, "host")[0].timeline_end
    removal = RippleRemoval.of(unselected=[(edge, edge + 0.5)])
    lane = _project_pad_lane(project, "host", edge, removal, defaults=DEFAULTS)
    assert not isinstance(lane, LaneUnavailable)
    assert any(c is p for c in lane for p in project.clips)
    before = _project_json(project)

    def bind() -> object:
        return bind_pause_effects(
            project,
            edge,
            removal,
            observation=GeometricPause(activity=()),
            splice_fade_ms=20,
            defaults=DEFAULTS,
        )

    bound = bind()
    assert not isinstance(bound, LaneUnavailable)
    assert bound
    assert _project_json(project) == before
    monkeypatch.setattr(timeline_ops, "clips_for_track", _old_lane_clips)
    assert bind() == bound


def test_a_removal_that_touches_no_clip_returns_the_projects_own_clips_unchanged(
    tmp_path: Path,
) -> None:
    """A clip outside every span comes back as itself."""
    project = _project(tmp_path, 7)
    first = clips_for_track(project, "host")[0]
    end = max(c.timeline_end for c in project.clips)
    removal = RippleRemoval.of(unselected=[(end + 1.0, end + 2.0)])
    lane = _project_pad_lane(project, "host", end + 1.0, removal, defaults=DEFAULTS)
    assert isinstance(lane, list)
    assert any(c is first for c in lane)
    assert first.model_dump_json() in _clip_json(project)
