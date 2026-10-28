from __future__ import annotations

import importlib.util
import random
import sys
from pathlib import Path

import pytest

from podcast_mcp.engines import session_timeline as module
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    _candidates_source,
    _clip_source_path,
    clip_media_key,
    clip_source_at_timeline,
)
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording, Track
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.workspace_paths import resolve_under_workspace

_EPS = 1e-9
_SEEDS = 300
_PROBES = 20


def _frozen_exact_source_span(self, track_id, start, end):
    """The list-scan implementation as it stood before the by-id index."""
    import math

    if end <= start:
        return None
    implicit_lanes = self._implicit_recording_lanes(track_id)
    if implicit_lanes - {track_id} or (implicit_lanes and self._recording_clips(track_id)):
        return None
    idx = self._exact_index(track_id)
    if idx is None:
        track = self._project.track_by_id(track_id)
        duration = track.media.duration_sec if track and track.media else None
        if (
            track is None
            or track.timeline_empty
            or any(c.track_id == track_id for c in self._project.clips)
            or duration is None
            or not math.isfinite(duration)
            or start < 0
            or end > duration
        ):
            return None
        return TimelineSec(float(start)), TimelineSec(float(end))
    source_cursor = float(start)
    timeline_start = None
    timeline_cursor = None
    for span in _candidates_source(idx, float(start), float(end)):
        lo = max(float(start), span.source_start)
        hi = min(float(end), span.source_end)
        if hi <= lo + _EPS:
            continue
        if abs(lo - source_cursor) > _EPS:
            return None
        tl_start = span.timeline_start + (lo - span.source_start)
        if timeline_cursor is not None and abs(tl_start - timeline_cursor) > _EPS:
            return None
        if timeline_start is None:
            timeline_start = tl_start
        source_cursor = hi
        timeline_cursor = tl_start + (hi - lo)
    if abs(source_cursor - float(end)) > _EPS or timeline_start is None or timeline_cursor is None:
        return None
    track = self._project.track_by_id(track_id)
    if track is None:
        return None
    media = resolve_under_workspace(
        self._project,
        track.media.path if track.media and track.media.path else f"track:{track_id}",
    )
    placement_cursor = timeline_start
    recording_clips = self._recording_clips(track_id)
    for clip in sorted(
        (c for c in self._project.clips if c.track_id == track_id or c in recording_clips),
        key=lambda c: c.timeline_start,
    ):
        lo = max(timeline_start, clip.timeline_start)
        hi = min(timeline_cursor, clip.timeline_end)
        if hi <= lo + _EPS:
            continue
        if clip not in recording_clips:
            return None
        if clip.source_id and _clip_source_path(self._project, clip) is None:
            return None
        if abs(lo - placement_cursor) > _EPS or not same_recording(
            resolve_under_workspace(self._project, clip_media_key(self._project, clip)),
            media,
        ):
            return None
        source_at_lo = clip_source_at_timeline(clip, lo)
        expected_source = float(start) + (lo - timeline_start)
        if abs(source_at_lo - expected_source) > _EPS:
            return None
        placement_cursor = hi
    if abs(placement_cursor - timeline_cursor) > _EPS:
        return None
    return TimelineSec(timeline_start), TimelineSec(timeline_cursor)


def _fuzz_project(seed: int, root: Path) -> tuple[EpisodeProject, list[tuple[str, float, float]]]:
    rng = random.Random(seed)
    project = EpisodeProject.create(f"span_{seed}", str(root / f"ws{seed}"))
    media = ["raw/a.wav", "raw/b.wav", "raw/a.wav"]
    lane_count = rng.randint(1, 3)
    lanes = [f"lane{i}" for i in range(lane_count)]
    project.timeline.tracks = [
        Track(
            id=lane,
            label=lane,
            media=MediaAsset(path=rng.choice(media), duration_sec=60.0)
            if rng.random() < 0.9
            else None,
        )
        for lane in lanes
    ]
    project.sources = [
        SourceRecording(id="s1", path="raw/a.wav"),
        SourceRecording(id="s2", path="raw/b.wav"),
        SourceRecording(id="s3", path="raw/a.wav"),
    ]
    pool = [f"c{i}" for i in range(rng.randint(2, 6))]
    clips: list[Clip] = []
    for lane in lanes:
        if rng.random() < 0.1:
            continue
        cursor = 0.0
        source = rng.choice([0.0, 5.0])
        for _ in range(rng.randint(1, 6)):
            length = rng.choice([1.0, 2.0, 2.5, 4.0])
            if rng.random() < 0.3:
                source += rng.choice([0.0, 1.5, 3.0])
            clip = Clip(
                id=rng.choice(pool) if rng.random() < 0.6 else f"{lane}-{len(clips)}",
                track_id=lane,
                source_id=rng.choice([None, None, "s1", "s2", "s3"]),
                source_start=source,
                source_end=source + length,
                timeline_start=cursor,
            )
            clips.append(clip)
            source += length
            cursor += length
            roll = rng.random()
            if roll < 0.15:
                cursor += rng.choice([0.5, 1.0])
            elif roll < 0.25:
                cursor -= rng.choice([0.5, 1.0])
    for clip in list(clips):
        roll = rng.random()
        if roll < 0.15:
            clips.append(clip.model_copy(deep=True))
        elif roll < 0.2:
            clips.append(clip)
        elif roll < 0.3:
            other = rng.choice(lanes)
            clips.append(clip.model_copy(update={"track_id": other}, deep=True))
        elif roll < 0.38:
            clips.append(clip.model_copy(update={"fade_in_ms": 10.0}, deep=True))
    rng.shuffle(clips)
    project.timeline.clips = clips
    probes: list[tuple[str, float, float]] = []
    for _ in range(_PROBES):
        lane = rng.choice(lanes)
        if clips and rng.random() < 0.8:
            clip = rng.choice(clips)
            lo, hi = clip.source_start, clip.source_end
            if rng.random() < 0.5:
                a, b = sorted(rng.uniform(lo, hi) for _ in range(2))
                lo, hi = a, b
        else:
            lo = rng.uniform(0.0, 10.0)
            hi = lo + rng.uniform(0.0, 5.0)
        probes.append((lane, lo, hi))
    return project, probes


def _outcomes(method, seed: int, root: Path) -> list[object]:
    project, probes = _fuzz_project(seed, root)
    timeline = SessionTimeline(project)
    results: list[object] = []
    for lane, lo, hi in probes:
        try:
            results.append(method(timeline, lane, SourceSec(lo), SourceSec(hi)))
        except Exception as error:
            results.append((type(error).__name__, str(error)))
    return results


def _mismatches(method, root: Path) -> tuple[int, int]:
    wrong = 0
    found = 0
    for seed in range(_SEEDS):
        expected = _outcomes(_frozen_exact_source_span, seed, root)
        actual = _outcomes(method, seed, root)
        found += sum(1 for item in expected if item is not None)
        wrong += sum(1 for left, right in zip(expected, actual, strict=True) if left != right)
    return wrong, found


def _mutant_method(tmp_path: Path, name: str, old: str, new: str):
    source = Path(module.__file__).read_text()
    assert source.count(old) == 1
    path = tmp_path / f"{name}.py"
    path.write_text(source.replace(old, new))
    spec = importlib.util.spec_from_file_location(f"_mutant_{name}", path)
    mutant = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mutant
    try:
        spec.loader.exec_module(mutant)
    finally:
        sys.modules.pop(spec.name, None)
    return mutant.SessionTimeline.exact_source_span


def test_exact_source_span_matches_list_scan_oracle(tmp_path):
    wrong, found = _mismatches(SessionTimeline.exact_source_span, tmp_path)
    assert wrong == 0
    assert found > 300


def test_equal_clips_on_another_lane_and_duplicates(tmp_path):
    project = EpisodeProject.create("dup", str(tmp_path / "ws"))
    project.timeline.tracks = [
        Track(id="a", label="a", media=MediaAsset(path="raw/x.wav", duration_sec=30.0)),
        Track(id="b", label="b", media=MediaAsset(path="raw/x.wav", duration_sec=30.0)),
    ]
    first = Clip(id="k", track_id="a", source_start=0.0, source_end=4.0, timeline_start=0.0)
    project.timeline.clips = [
        first,
        first.model_copy(deep=True),
        Clip(id="k", track_id="b", source_start=0.0, source_end=4.0, timeline_start=0.0),
    ]
    timeline = SessionTimeline(project)
    for lane in ("a", "b"):
        got = timeline.exact_source_span(lane, SourceSec(0.0), SourceSec(4.0))
        want = _frozen_exact_source_span(timeline, lane, SourceSec(0.0), SourceSec(4.0))
        assert got == want


def test_exact_source_span_compares_clips_far_less_than_list_scan(tmp_path, monkeypatch):
    project = EpisodeProject.create("spy", str(tmp_path / "ws"))
    lanes = ["host", "guest", "extra"]
    project.timeline.tracks = [
        Track(id=lane, label=lane, media=MediaAsset(path=f"raw/{lane}.wav", duration_sec=900.0))
        for lane in lanes
    ]
    project.timeline.clips = [
        Clip(
            id=f"{lane}-{i}",
            track_id=lane,
            source_start=float(i) * 3.0,
            source_end=float(i) * 3.0 + 3.0,
            timeline_start=float(i) * 3.0,
        )
        for lane in lanes
        for i in range(95)
    ]
    timeline = SessionTimeline(project)
    calls = 0
    original = Clip.__eq__

    def counting(self, other):
        nonlocal calls
        calls += 1
        return original(self, other)

    monkeypatch.setattr(Clip, "__eq__", counting)
    got = timeline.exact_source_span("host", SourceSec(30.0), SourceSec(33.0))
    new_calls = calls
    calls = 0
    want = _frozen_exact_source_span(timeline, "host", SourceSec(30.0), SourceSec(33.0))
    old_calls = calls
    assert got == want is not None
    assert old_calls > len(project.clips)
    assert new_calls < len(project.clips) // 10


@pytest.mark.parametrize(
    ("name", "old", "new"),
    [
        (
            "id_only",
            "other is clip or other == clip",
            "True",
        ),
        (
            "no_cross_lane",
            "if c.track_id == track_id or _has_equal_clip(recording_clips, c)",
            "if c.track_id == track_id",
        ),
        (
            "first_of_bucket",
            "for other in grouped.get(clip.id, ())",
            "for other in grouped.get(clip.id, ())[:1]",
        ),
    ],
)
def test_mutants_are_caught(tmp_path, name, old, new):
    method = _mutant_method(tmp_path, name, old, new)
    wrong, _ = _mismatches(method, tmp_path)
    assert wrong > 0
