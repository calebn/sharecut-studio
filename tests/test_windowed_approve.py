"""An approve check reads its few seconds from a window, not a whole-track rebuild, on the batch-base profile (#2357)."""

from __future__ import annotations

import dataclasses
import itertools
import os
import subprocess
import wave
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_application, cut_proof, cut_safety, verdict_cache
from podcast_mcp.edits.cut_application import apply_prefix_edits, approve_edits, precompute_verdicts
from podcast_mcp.engines import track_evidence
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_track_rms_caches
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.engines.mute_regions import add_source_mute
from podcast_mcp.engines.play_audit import stem_path, write_stem_hash
from podcast_mcp.engines.windowed_rms import TimelineWindow, WindowedTrackRmsCache, WindowMiss
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

SR = 48_000
SECONDS = 100
CUTS = (40.0, 41.5, 43.0, 44.5, 70.0)  # four within reach of one another, one far away


def _write(path: Path, seed: int, words: list[float]) -> None:
    rng = np.random.default_rng(seed)
    audio = rng.normal(0.0, 0.0003, SECONDS * SR)
    for start in words:
        t = np.arange(round(0.35 * SR)) / SR
        audio[round(start * SR) : round(start * SR) + t.size] += (
            0.2 * np.sin(2 * np.pi * 180 * t) * rng.uniform(0.5, 1.0, t.size)
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((audio * 32767).astype("<i2").tobytes())


def _project(tmp_path: Path, *, chained: tuple[str, ...] = ("host", "guest")) -> EpisodeProject:
    host_words = [float(s) for s in range(30, 90)]
    guest_words = [33.5, 38.2, 46.2, 52.0, 66.5]
    _write(tmp_path / "raw" / "host.wav", 1, [w for w in host_words if w not in CUTS])
    _write(tmp_path / "raw" / "guest.wav", 2, guest_words)
    project = EpisodeProject.create("windowed", str(tmp_path))
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
    edges = [0.0, 20.0, 55.0, 80.0, float(SECONDS)]
    project.clips = [
        Clip(
            id=f"{tid}{i}",
            track_id=tid,
            source_start=a,
            source_end=b,
            timeline_start=a,
            fade_in_ms=20 if i else 0,
            fade_out_ms=20 if i < 3 else 0,
        )
        for tid in ("host", "guest")
        for i, (a, b) in enumerate(itertools.pairwise(edges))
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um" if s in CUTS else f"w{i}", start=s, end=s + 0.35)
                for i, s in enumerate(host_words)
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text=f"g{i}", start=s, end=s + 0.35)
                for i, s in enumerate(guest_words)
            ],
        ),
    ]
    project.mix.processing_chains = [
        # The evidence tree leaves the effects chain out (``unfiltered_track_audio``), so a chain
        # only decides which tracks take the windowed path; its parameters change no sample here.
        ProcessingChain(track_id=tid, effects=[ProcessingEffect(effect="highpass", params={})])
        for tid in chained
    ]
    project.timeline.duration_sec = SECONDS
    project.edit_decisions = [
        EditDecision(
            id=f"c{i}",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=s,
            end=s + 0.35,
            reason="filler:um",
            applied=False,
            boundary_mode="vocal_transcript_guided",
        )
        for i, s in enumerate(CUTS)
    ]
    return project


@pytest.fixture(autouse=True)
def _no_verdict_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every check observes, so each one asks for timeline caches."""
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")


class _Counts:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.whole: list[str] = []
        self.windows: list[tuple[float, float]] = []
        self.declined = 0
        self.fell_back = 0
        real_eval, real_window = track_evidence._evaluate, track_evidence.rms_window
        real_whole = cut_proof.CarriedTimelineRms.whole

        def evaluate(tree, curve):  # type: ignore[no-untyped-def]
            self.whole.append(curve)
            return real_eval(tree, curve)

        def window(project, track_id, defaults, start, end, **kwargs):  # type: ignore[no-untyped-def]
            found = real_window(project, track_id, defaults, start, end, **kwargs)
            if found is None:
                self.declined += 1
            else:
                self.windows.append((start, end))
            return found

        def whole(timeline, project, *, defaults):  # type: ignore[no-untyped-def]
            self.fell_back += 1
            return real_whole(timeline, project, defaults=defaults)

        monkeypatch.setattr(track_evidence, "_evaluate", evaluate)
        monkeypatch.setattr(track_evidence, "rms_window", window)
        monkeypatch.setattr(cut_proof.CarriedTimelineRms, "whole", whole)


def _approve(project: EpisodeProject) -> dict:
    held: list = []
    asked: list = []
    count = approve_edits(
        project,
        [e.id for e in project.edit_decisions],
        defaults=load_defaults(),
        held_out=held,
        asked_out=asked,
    )
    return {
        "count": count,
        "held": [dataclasses.asdict(h) for h in held],
        "asked": [dataclasses.asdict(a) for a in asked],
        "clips": sorted(
            (
                c.track_id,
                c.source_start,
                c.source_end,
                c.timeline_start,
                c.fade_in_ms,
                c.fade_out_ms,
            )
            for c in project.clips
        ),
        "edits": [(e.id, e.applied) for e in project.edit_decisions],
    }


def test_cuts_within_reach_of_each_other_evaluate_each_track_once_and_window_the_rest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    counts = _Counts(monkeypatch)

    outcome = _approve(project)

    assert outcome["held"] == [] and outcome["count"] == len(CUTS)
    # the base build evaluates the two chained tracks once; the three cuts beside an applied one
    # read windows (one per chained track) and evaluate nothing
    assert len(counts.whole) == 2
    assert len(counts.windows) == 3 * 2
    assert counts.fell_back == 0 and counts.declined == 0
    assert all(end - start < 20.0 for start, end in counts.windows)


def test_without_windows_the_same_batch_evaluates_a_track_again_for_every_close_cut(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    counts = _Counts(monkeypatch)
    # after the counter, so every window is declined and none is counted
    monkeypatch.setattr(track_evidence, "rms_window", lambda *args, **kwargs: None)

    _approve(_project(tmp_path))

    assert len(counts.whole) == 2 + 3 * 2


def test_a_windowed_batch_decides_as_the_same_batch_on_whole_track_rebuilds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    windowed = _approve(_project(tmp_path / "windowed"))
    monkeypatch.setattr(track_evidence, "rms_window", lambda *args, **kwargs: None)
    rebuilt = _approve(_project(tmp_path / "rebuilt"))

    assert windowed == rebuilt


def test_a_check_that_reads_outside_its_window_is_made_again_on_whole_caches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _approve(_project(tmp_path / "expected"))
    counts = _Counts(monkeypatch)
    # a window of two seconds, where the checks read five: every windowed read misses
    monkeypatch.setattr(verdict_cache, "check_reach_sec", lambda *args, **kwargs: 2.0)

    outcome = _approve(_project(tmp_path / "narrow"))

    assert counts.fell_back > 0
    assert outcome == expected


def test_a_windowed_check_reads_inside_the_window_around_its_cut(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reads: list[tuple[float, float, tuple[int, int]]] = []
    real = WindowedTrackRmsCache.window

    def spy(self, t_start, t_end):  # type: ignore[no-untyped-def]
        reads.append((t_start, t_end, self.coverage))
        return real(self, t_start, t_end)

    monkeypatch.setattr(WindowedTrackRmsCache, "window", spy)
    counts = _Counts(monkeypatch)

    _approve(_project(tmp_path))

    assert counts.fell_back == 0
    assert len(reads) > 20
    rate = 8000
    for t0, t1, (first, last) in reads:
        assert first <= round(t0 * rate) and round(t1 * rate) <= last + rate // 100
    assert any(t1 - t0 > 5.0 for t0, t1, _ in reads)  # the context reads are the long ones


def _with_a_fresh_guest_stem(project: EpisodeProject) -> None:
    stem = stem_path(project, "guest")
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes((Path(project.workspace_dir) / "raw" / "guest.wav").read_bytes())
    write_stem_hash(project, "guest", defaults=load_defaults())


def test_a_stem_gone_stale_after_a_cut_does_not_evaluate_a_chained_track_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guest has a fresh stem and no chain; the host has a chain and no stem."""
    project = _project(tmp_path / "windowed", chained=("host",))
    _with_a_fresh_guest_stem(project)
    counts = _Counts(monkeypatch)
    outcome = _approve(project)

    assert outcome["held"] == [] and outcome["count"] == len(CUTS)
    assert len(counts.whole) == 1  # the host, once
    assert counts.fell_back == 0

    monkeypatch.setattr(track_evidence, "rms_window", lambda *args, **kwargs: None)
    rebuilt = _project(tmp_path / "rebuilt", chained=("host",))
    _with_a_fresh_guest_stem(rebuilt)
    assert _approve(rebuilt) == outcome


# --- the profile definition --------------------------------------------------------------


def _record_profiles(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, LevelProfile]]:
    seen: list[dict[str, LevelProfile]] = []
    real = cut_safety.observe_source_cut

    def spy(*args, timeline_caches: TrackRmsCacheSet, **kwargs):  # type: ignore[no-untyped-def]
        seen.append({tid: c.profile for tid, c in timeline_caches.caches.items()})
        return real(*args, timeline_caches=timeline_caches, **kwargs)

    monkeypatch.setattr(cut_safety, "observe_source_cut", spy)
    return seen


def _profile_of_whole_track(project: EpisodeProject) -> dict[str, LevelProfile]:
    caches = build_track_rms_caches(
        project, track_ids=["host", "guest"], unprocessed=True, defaults=load_defaults()
    )
    return {tid: c.profile for tid, c in caches.caches.items()}


def _assert_every_check_reads_the_profile_before_the_batch(
    seen: list[dict[str, LevelProfile]], before: dict[str, LevelProfile], after: dict
) -> None:
    assert len(seen) >= len(CUTS)
    for profiles in seen:
        assert profiles == before  # bit for bit, every track, every check
    # not vacuous: the profile of the track the batch left differs from the one before it
    assert after["host"] != before["host"]


@pytest.mark.parametrize("chained", [("host", "guest"), ("host",), ()])
def test_approve_reads_every_check_on_the_profile_before_the_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, chained: tuple[str, ...]
) -> None:
    project = _project(tmp_path, chained=chained)
    before = _profile_of_whole_track(project)
    seen = _record_profiles(monkeypatch)

    _approve(project)

    _assert_every_check_reads_the_profile_before_the_batch(
        seen, before, _profile_of_whole_track(project)
    )


def test_the_idle_warm_reads_every_check_on_the_profile_before_the_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    project = _project(tmp_path)
    before = _profile_of_whole_track(project)
    seen = _record_profiles(monkeypatch)
    verdict_cache._STORE.clear()

    checked = precompute_verdicts(
        project, [e.id for e in project.edit_decisions], defaults=load_defaults()
    )

    assert checked == len(CUTS)
    assert len(seen) == len(CUTS) and all(profiles == before for profiles in seen)
    # the warm changes nothing, and so the project's own profile is still the one before
    assert _profile_of_whole_track(project) == before


def test_auto_apply_reads_every_check_on_the_profile_before_the_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    before = _profile_of_whole_track(project)
    seen = _record_profiles(monkeypatch)

    applied = apply_prefix_edits(project, "filler:", config_key="test", defaults=load_defaults())

    assert applied == len(CUTS)
    _assert_every_check_reads_the_profile_before_the_batch(
        seen, before, _profile_of_whole_track(project)
    )


def test_a_rebuilt_set_reports_the_profile_of_its_base_not_its_own_samples(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    timeline = cut_proof.CarriedTimelineRms(project)
    first = timeline.caches_for(project, (40.0, 40.35), reach=6.0, defaults=defaults)
    base = {tid: c.profile for tid, c in first.caches.items()}
    # the project after a 3 s cut at 20 s in both tracks
    shorter = project.model_copy(deep=True)
    for clip in shorter.clips:
        if clip.source_start == 20.0:
            clip.source_start = 23.0
        elif clip.source_start > 20.0:
            clip.timeline_start -= 3.0
    timeline.applied(10.0)  # an applied cut near the start: every later check is within reach of it

    rebuilt = timeline.caches_for(shorter, (40.0, 40.35), reach=6.0, defaults=defaults)

    assert {tid: c.profile for tid, c in rebuilt.caches.items()} == base
    assert any(isinstance(c, WindowedTrackRmsCache) for c in rebuilt.caches.values())
    assert _profile_of_whole_track(shorter) != base


# --- the verdict key ----------------------------------------------------------------------


def test_the_verdict_key_names_the_semantics_of_the_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {
        "defaults": load_defaults(),
        "manual": False,
        "batch": (),
        "span": (40.0, 40.35),
        "base_profile": "test-base",
    }
    parts = verdict_cache.key_parts(project, edit, **kwargs)
    assert parts is not None and "semantics" in parts
    key = verdict_cache.verdict_key(project, edit, **kwargs)

    monkeypatch.setattr(verdict_cache, "SEMANTICS", "profile-of-the-track-as-the-cut-left-it")

    assert verdict_cache.verdict_key(project, edit, **kwargs) != key


def test_a_stored_verdict_made_under_other_semantics_is_not_reused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    project = _project(tmp_path)
    defaults = load_defaults()
    ids = [e.id for e in project.edit_decisions]
    monkeypatch.setattr(verdict_cache, "SEMANTICS", "older")
    precompute_verdicts(project, ids, defaults=defaults)
    older = len(verdict_cache._STORE)
    assert older > 0

    monkeypatch.setattr(verdict_cache, "SEMANTICS", "batch-base-profile")
    hits = _count_hits(monkeypatch)
    precompute_verdicts(project, ids, defaults=defaults)

    assert hits == []
    assert len(verdict_cache._STORE) == 2 * older


def test_a_plain_track_the_rebuild_drops_is_absent_from_a_carried_set_not_its_old_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plain track with no samples now, or whose raw read failed, has no cache in a rebuild."""
    project = _project(tmp_path, chained=("host",))
    defaults = load_defaults()
    timeline = cut_proof.CarriedTimelineRms(project)
    first = timeline.caches_for(project, (40.0, 40.35), reach=6.0, defaults=defaults)
    assert set(first.caches) == {"host", "guest"}
    real = cut_proof.build_track_rms_caches

    def without_guest(*args, **kwargs):  # type: ignore[no-untyped-def]
        built = real(*args, **kwargs)
        return TrackRmsCacheSet(
            caches={tid: c for tid, c in built.caches.items() if tid != "guest"}
        )

    monkeypatch.setattr(cut_proof, "build_track_rms_caches", without_guest)
    timeline.applied(10.0)
    timeline._stems_fresh = (True, True)  # a stem went stale: the plain tracks are built again

    carried = timeline._carried_with_current_stems(project, defaults)

    assert set(carried.caches) == {"host"}
    assert carried.caches["host"] is first.caches["host"]  # the chained track keeps its evidence


def test_a_plain_track_with_a_stale_stem_gets_the_rebuilt_cache_not_the_carried_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, chained=("host",))
    defaults = load_defaults()
    timeline = cut_proof.CarriedTimelineRms(project)
    first = timeline.caches_for(project, (40.0, 40.35), reach=6.0, defaults=defaults)
    real = cut_proof.build_track_rms_caches
    built: list[TrackRmsCacheSet] = []

    def record(*args, **kwargs):  # type: ignore[no-untyped-def]
        built.append(real(*args, **kwargs))
        return built[-1]

    monkeypatch.setattr(cut_proof, "build_track_rms_caches", record)
    timeline.applied(10.0)
    timeline._stems_fresh = (True, True)  # a stem went stale: the plain tracks are built again

    carried = timeline._carried_with_current_stems(project, defaults)

    assert carried.caches["guest"] is built[-1].caches["guest"]
    assert carried.caches["guest"] is not first.caches["guest"]
    assert carried.caches["host"] is first.caches["host"]


# --- the verdict key carries the batch-base profile -----------------------------------------

HUMAN = CutIntent.HUMAN_BOUNDARIES  # the mute below sits on speech, which only a person may mute


def _with_a_mute_far_from_the_cuts(project: EpisodeProject) -> str:
    project.edit_decisions.append(
        EditDecision(
            id="mute",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=81.0,
            end=88.0,
            reason="test",
            applied=False,
        )
    )
    return "mute"


def _approve_ids(project: EpisodeProject, ids: list[str], hits: list[str]) -> dict:
    held: list = []
    asked: list = []
    count = approve_edits(
        project,
        ids,
        defaults=load_defaults(),
        held_out=held,
        asked_out=asked,
        application_intent=HUMAN,
    )
    return {
        "count": count,
        "held": [dataclasses.asdict(h) for h in held],
        "asked": [dataclasses.asdict(a) for a in asked],
        "edits": [(e.id, e.applied) for e in project.edit_decisions],
        "hits": len(hits),
    }


def _count_hits(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    hits: list[str] = []
    real = verdict_cache.lookup

    def lookup(key: str | None) -> verdict_cache.CachedVerdict | None:
        found = real(key)
        if found is not None and key is not None:
            hits.append(key)
        return found

    monkeypatch.setattr(verdict_cache, "lookup", lookup)
    return hits


def _warm_then_approve_with_a_mute(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, warm: bool
) -> dict:
    """Warm the pending cuts on the project as it is, then approve them with a mute that moves the base."""
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1" if warm else "0")
    verdict_cache._STORE.clear()
    project = _project(tmp_path)
    cut_ids = [e.id for e in project.edit_decisions]
    mute = _with_a_mute_far_from_the_cuts(project)
    if warm:
        precompute_verdicts(project, cut_ids, defaults=load_defaults(), application_intent=HUMAN)
    return _approve_ids(project, [mute, *cut_ids], _count_hits(monkeypatch))


def test_a_verdict_warmed_before_a_mute_moved_the_base_profile_is_not_reused_after_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _profile_of_whole_track(_project(tmp_path / "probe"))
    muted = _project(tmp_path / "probe-muted")
    _approve_ids(muted, [_with_a_mute_far_from_the_cuts(muted)], [])
    assert _profile_of_whole_track(muted)["host"] != before["host"]  # the mute moves the base

    warm = _warm_then_approve_with_a_mute(tmp_path / "warm", monkeypatch, warm=True)
    cold = _warm_then_approve_with_a_mute(tmp_path / "cold", monkeypatch, warm=False)

    assert warm == cold  # the same verdicts, and no hit: the warm entries are on the other base
    assert warm["hits"] == 0
    assert warm["count"] == len(CUTS) + 1


def test_a_verdict_warmed_on_the_same_base_profile_is_reused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stamp is exact, not coarse: an unchanged base keeps every hit."""
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    project = _project(tmp_path)
    ids = [e.id for e in project.edit_decisions]
    precompute_verdicts(project, ids, defaults=load_defaults())
    hits = _count_hits(monkeypatch)

    outcome = approve_edits(project, ids, defaults=load_defaults(), held_out=[], asked_out=[])

    assert outcome == len(CUTS)
    assert len(hits) == len(CUTS)


def test_the_verdict_key_differs_with_the_base_profile(tmp_path: Path) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": (40.0, 40.35)}
    base = cut_proof.BatchBase(project).stamp(defaults=load_defaults())

    assert cut_proof.BatchBase(project).stamp(defaults=load_defaults()) == base
    key = verdict_cache.verdict_key(project, edit, base_profile=base, **kwargs)
    assert key is not None
    assert verdict_cache.verdict_key(project, edit, base_profile=base, **kwargs) == key
    assert verdict_cache.verdict_key(project, edit, base_profile="other", **kwargs) != key
    parts = verdict_cache.key_parts(project, edit, base_profile=base, **kwargs)
    assert parts is not None and "base_profile" in parts


def _stamp(project: EpisodeProject, defaults: dict | None = None) -> str:
    return cut_proof.BatchBase(project).stamp(defaults=defaults or load_defaults())


def test_the_stamp_decodes_and_builds_no_audio_and_starts_no_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    from podcast_mcp.engines import audio_audit, level_profile, ungated_audio

    project = _project(tmp_path)
    expected = _stamp(project)

    def refuse(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("the stamp built or decoded audio, or started a process")

    for module, name in (
        (cut_proof, "build_track_rms_caches"),
        (cut_proof, "shared_timeline_rms_caches"),
        (audio_audit, "build_track_rms_caches"),
        (track_evidence, "_evaluate"),
        (track_evidence, "rms_readers"),
        (ungated_audio, "load_mono_full"),
        (ungated_audio, "raw_samples_on_timeline"),
        (level_profile, "load_mono_full"),
        (level_profile, "file_level_profile"),
        (subprocess, "run"),
        (subprocess, "Popen"),
    ):
        monkeypatch.setattr(module, name, refuse)

    assert _stamp(project) == expected


def test_the_stamp_is_stable_across_two_builds_of_the_same_inputs(tmp_path: Path) -> None:
    project = _project(tmp_path)
    assert _stamp(project) == _stamp(project) == _stamp(project.model_copy(deep=True))


def _with_a_bed(project: EpisodeProject, bed: Path) -> None:
    """A mute on the host's last clip whose room-tone fill reads the recorded bed ``bed``."""
    from podcast_mcp.models import ClipMuteRegion, RoomToneFill, SourceRecording

    project.sources.append(SourceRecording(id="bed", path=str(bed), duration_sec=3.0))
    clip = next(c for c in project.clips if c.track_id == "host" and c.source_start == 80.0)
    add_source_mute(
        clip,
        ClipMuteRegion(
            start_s=85.0, end_s=86.0, fill=RoomToneFill(start_s=0.0, end_s=1.0, source_id="bed")
        ),
    )


def _rewrite(path: Path, seed: int) -> None:
    """Other bytes at the path, as a replaced file: a new file with a later mtime."""
    path.unlink()
    _write(path, seed, [])
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))


def test_a_mute_on_any_dialogue_track_shifts_the_stamp(tmp_path: Path) -> None:
    project = _project(tmp_path)
    before = _stamp(project)

    def muted(track_id: str) -> EpisodeProject:
        copy = project.model_copy(deep=True)
        clip = next(c for c in copy.clips if c.track_id == track_id and c.source_start == 80.0)
        add_source_mute(clip, ClipMuteRegion(start_s=85.0, end_s=86.0, fill=None))
        return copy

    assert _stamp(muted("host")) != before
    assert _stamp(muted("guest")) != before  # the base covers every dialogue track
    assert _stamp(muted("host")) != _stamp(muted("guest"))


def test_the_bed_a_mute_fill_reads_is_part_of_the_stamp(tmp_path: Path) -> None:
    project = _project(tmp_path)
    bed = tmp_path / "raw" / "bed.wav"
    _write(bed, 7, [])
    _with_a_bed(project, bed)
    before = _stamp(project)
    assert _stamp(project) == before

    _rewrite(bed, 8)  # the same source id, other bytes
    assert _stamp(project) != before


def test_the_source_a_mute_fill_names_is_part_of_the_stamp(tmp_path: Path) -> None:
    project = _project(tmp_path)
    for seed, name in ((7, "bed.wav"), (8, "other.wav")):
        _write(tmp_path / "raw" / name, seed, [])
    _with_a_bed(project, tmp_path / "raw" / "bed.wav")
    before = _stamp(project)

    from podcast_mcp.models import SourceRecording

    project.sources = [
        SourceRecording(id="bed", path=str(tmp_path / "raw" / "other.wav"), duration_sec=3.0)
    ]
    assert _stamp(project) != before


def test_the_crossfade_curve_is_part_of_the_stamp(tmp_path: Path) -> None:
    import copy

    project = _project(tmp_path)
    defaults = load_defaults()
    other = copy.deepcopy(defaults)
    other["render"]["crossfade_curve"] = "qsin"
    assert defaults["render"].get("crossfade_curve", "tri") != "qsin"

    assert _stamp(project, other) != _stamp(project, defaults)


def test_a_volume_envelope_is_part_of_the_stamp(tmp_path: Path) -> None:
    from podcast_mcp.models import AutomationEnvelope, AutomationPoint

    project = _project(tmp_path)
    before = _stamp(project)
    project.automation_envelopes = [
        AutomationEnvelope(
            track_id="host",
            points=[
                AutomationPoint(id="a", time=0.0, value=1.0),
                AutomationPoint(id="b", time=5.0, value=0.5),
            ],
        )
    ]

    assert _stamp(project) != before


def test_a_replaced_recording_is_part_of_the_stamp(tmp_path: Path) -> None:
    project = _project(tmp_path)
    before = _stamp(project)
    _rewrite(tmp_path / "raw" / "host.wav", 99)  # same ids, clips and path; other bytes

    assert _stamp(project) != before


# --- the stem is part of the stamp --------------------------------------------------------


def test_a_replaced_stem_a_changed_sidecar_and_a_removed_stem_each_change_the_stamp(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path, chained=("host",))
    _with_a_fresh_guest_stem(project)
    fresh = _stamp(project)
    assert _stamp(project) == fresh
    stem = stem_path(project, "guest")
    sidecar = stem.with_suffix(".hash")
    assert sidecar.is_file()
    stats = stem.stat()

    # the sidecar alone: the stem file and the render hash are as they were
    original = sidecar.read_text()
    sidecar.write_text(original.strip() + "x\n")
    assert _stamp(project) != fresh
    sidecar.write_text(original)
    assert _stamp(project) == fresh

    # the stem alone: other bytes of the same size at the same path, a later mtime
    stem.write_bytes(bytes(reversed(stem.read_bytes())))
    os.utime(stem, ns=(stats.st_atime_ns, stats.st_mtime_ns + 5_000_000_000))
    assert _stamp(project) != fresh

    stem.unlink()  # no stem at all
    assert _stamp(project) != fresh


def test_a_stem_whose_stat_fails_gives_a_stamp_without_a_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, chained=("host",))
    _with_a_fresh_guest_stem(project)
    fresh = _stamp(project)
    real = cut_proof.file_revision
    stem = stem_path(project, "guest")

    def revision(path: Path):  # type: ignore[no-untyped-def]
        if path == stem:
            raise OSError("gone")
        return real(path)

    monkeypatch.setattr(cut_proof, "file_revision", revision)

    unreadable = _stamp(project)

    assert unreadable != fresh  # without the revision it is another input


def test_the_stamp_is_computed_once_per_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    calls: list[str] = []
    real = cut_proof.track_render_hash

    def counted(p, tid, **kw):  # type: ignore[no-untyped-def]
        calls.append(tid)
        return real(p, tid, **kw)

    monkeypatch.setattr(cut_proof, "track_render_hash", counted)
    base = cut_proof.BatchBase(project)

    first = base.stamp(defaults=load_defaults())
    count = len(calls)

    assert count == 2 and base.stamp(defaults=load_defaults()) == first
    assert len(calls) == count


# --- the core property: what changes the whole-track profile changes the stamp ------------


def _mute_the_words(project: EpisodeProject) -> None:
    for clip in project.clips:
        if clip.track_id == "host" and clip.source_start == 55.0:
            add_source_mute(clip, ClipMuteRegion(start_s=57.0, end_s=70.0, fill=None))


def _replace_the_host(project: EpisodeProject) -> None:
    raw = Path(project.workspace_dir) / "raw" / "host.wav"
    raw.unlink()
    _write(raw, 41, [float(s) for s in range(30, 60)])


def _drop_a_clip(project: EpisodeProject) -> None:
    project.clips = [c for c in project.clips if c.id != "host2"]


@pytest.mark.parametrize("mutate", [_mute_the_words, _replace_the_host, _drop_a_clip])
def test_what_moves_the_whole_track_profile_moves_the_stamp(
    tmp_path: Path, mutate: Callable[[EpisodeProject], None]
) -> None:
    project = _project(tmp_path)
    twin = project.model_copy(deep=True)
    before, stamp = _profile_of_whole_track(project), _stamp(project)
    # equal inputs: the same stamp and the same profiles
    assert _stamp(twin) == stamp and _profile_of_whole_track(twin) == before

    mutate(project)

    assert _profile_of_whole_track(project)["host"] != before["host"]
    assert _stamp(project) != stamp


# --- a stamp that cannot be had, and a window the check overruns --------------------------


@pytest.mark.parametrize(
    "error", [OSError("a recording is unreadable"), ValueError("bad"), KeyError("gone")]
)
def test_a_stamp_that_cannot_be_measured_gives_no_key_and_the_cut_is_still_checked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    expected = _approve(_project(tmp_path / "expected"))
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()

    def unreadable(self, *, defaults):  # type: ignore[no-untyped-def]
        raise error

    monkeypatch.setattr(cut_proof.BatchBase, "stamp", unreadable)

    outcome = _approve(_project(tmp_path / "unstamped"))

    assert outcome == expected
    assert len(verdict_cache._STORE) == 0  # nothing was stored under a key


def test_a_stamp_that_fails_for_another_reason_is_not_swallowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()

    def broken(self, *, defaults):  # type: ignore[no-untyped-def]
        raise RuntimeError("a bug")

    monkeypatch.setattr(cut_proof.BatchBase, "stamp", broken)

    with pytest.raises(RuntimeError, match="a bug"):
        _approve(_project(tmp_path))


def test_the_verdict_key_of_a_later_cut_carries_the_stamp_of_the_batch_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    start = project.model_copy(deep=True)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    stamps: list[str] = []
    real = verdict_cache.verdict_key

    def spy(*args, base_profile: str, **kwargs):  # type: ignore[no-untyped-def]
        stamps.append(base_profile)
        return real(*args, base_profile=base_profile, **kwargs)

    monkeypatch.setattr(verdict_cache, "verdict_key", spy)

    outcome = _approve(project)

    assert outcome["count"] >= 2  # an earlier cut was applied before a later one is checked
    assert len(stamps) >= len(CUTS)
    assert set(stamps) == {cut_proof.BatchBase(start).stamp(defaults=defaults)}
    assert cut_proof.BatchBase(project).stamp(defaults=defaults) not in stamps  # not vacuous


def test_a_window_miss_in_observe_is_made_again_on_whole_caches_with_the_same_verdict(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    defaults = load_defaults()
    placed = cut_safety.source_cut_placement(project, edit)
    caches = cut_application.shared_source_audio_caches(project)
    wholes: list[int] = []

    class Overrun:
        def caches_for(self, project, span, *, reach, defaults):  # type: ignore[no-untyped-def]
            raise WindowMiss("a read left the window")

        def whole(self, project, *, defaults):  # type: ignore[no-untyped-def]
            wholes.append(1)
            return cut_application.shared_timeline_rms_caches(project, defaults=defaults)

    def observe(timeline):  # type: ignore[no-untyped-def]
        return cut_application._observe(
            project,
            edit,
            defaults=defaults,
            manual=False,
            batch=(),
            audio_caches=caches,
            timeline=timeline,
            placed=placed,
        )

    assert observe(Overrun()) == observe(None)
    assert wholes == [1]


def test_a_value_error_from_the_timeline_caches_is_not_made_again_on_whole_caches(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]

    class Broken:
        def caches_for(self, project, span, *, reach, defaults):  # type: ignore[no-untyped-def]
            raise ValueError("a bug")

        def whole(self, project, *, defaults):  # type: ignore[no-untyped-def]
            raise AssertionError("only a window miss is made again on whole caches")

    with pytest.raises(ValueError, match="a bug"):
        cut_application._observe(
            project,
            edit,
            defaults=load_defaults(),
            manual=False,
            batch=(),
            audio_caches=cut_application.shared_source_audio_caches(project),
            timeline=Broken(),  # type: ignore[arg-type]
            placed=cut_safety.source_cut_placement(project, edit),
        )


# --- build_track_rms_caches(window=...) ----------------------------------------------------


def _window_over(profiles: dict[str, LevelProfile]) -> TimelineWindow:
    return TimelineWindow(38.0, 44.0, profiles)


def test_each_windowed_track_reports_its_own_profile_and_a_track_without_one_is_built_whole(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    host = LevelProfile(room_db=-70.0, speech_db=-20.0, loud_db=-15.0)
    guest = LevelProfile(room_db=-65.0, speech_db=-25.0, loud_db=-18.0)

    both = build_track_rms_caches(
        project,
        track_ids=["host", "guest"],
        unprocessed=True,
        window=_window_over({"host": host, "guest": guest}),
        defaults=defaults,
    )
    assert both.caches["host"].profile == host and both.caches["guest"].profile == guest
    assert all(isinstance(c, WindowedTrackRmsCache) for c in both.caches.values())

    only_host = build_track_rms_caches(
        project,
        track_ids=["host", "guest"],
        unprocessed=True,
        window=_window_over({"host": host}),
        defaults=defaults,
    )
    assert isinstance(only_host.caches["host"], WindowedTrackRmsCache)
    assert not isinstance(only_host.caches["guest"], WindowedTrackRmsCache)

    processed = build_track_rms_caches(
        project,
        track_ids=["host"],
        unprocessed=False,
        window=_window_over({"host": host}),
        defaults=defaults,
    )
    assert not isinstance(processed.caches["host"], WindowedTrackRmsCache)


@pytest.mark.parametrize(
    "error", [OSError("gone"), ValueError("bad"), subprocess.CalledProcessError(1, "x")]
)
def test_a_window_that_cannot_be_built_is_left_to_the_whole_track_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    project = _project(tmp_path)

    def broken(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise error

    monkeypatch.setattr(track_evidence, "rms_window", broken)
    host = LevelProfile(room_db=-70.0, speech_db=-20.0, loud_db=-15.0)

    built = build_track_rms_caches(
        project,
        track_ids=["host"],
        unprocessed=True,
        window=_window_over({"host": host}),
        defaults=load_defaults(),
    )

    assert not isinstance(built.caches["host"], WindowedTrackRmsCache)
    assert built.caches["host"].profile != host  # its own, from its samples


def test_a_window_that_raises_something_else_is_not_swallowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise KeyError("a bug")

    monkeypatch.setattr(track_evidence, "rms_window", broken)
    with pytest.raises(KeyError):
        build_track_rms_caches(
            _project(tmp_path),
            track_ids=["host"],
            unprocessed=True,
            window=_window_over({"host": BASE_PROFILE}),
            defaults=load_defaults(),
        )


BASE_PROFILE = LevelProfile(room_db=-70.0, speech_db=-20.0, loud_db=-15.0)


# --- BatchBase.adopt and CarriedTimelineRms ------------------------------------------------


def test_adopt_reports_base_profiles_off_the_start_and_returns_the_start_set_itself(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    base = cut_proof.BatchBase(project)
    own = cut_proof.shared_timeline_rms_caches(project, defaults=defaults)
    assert base.adopt(project, own, defaults=defaults) is own

    shorter = project.model_copy(deep=True)
    shorter.clips = [c for c in shorter.clips if c.id != "host2"]
    rebuilt = build_track_rms_caches(
        shorter, track_ids=["host", "guest"], unprocessed=True, defaults=defaults
    )
    assert rebuilt.caches["host"].profile != own.caches["host"].profile

    adopted = base.adopt(shorter, rebuilt, defaults=defaults)

    assert {t: c.profile for t, c in adopted.caches.items()} == {
        t: c.profile for t, c in own.caches.items()
    }
    assert adopted.caches["host"].samples is rebuilt.caches["host"].samples  # no copy of audio


def test_the_profiles_come_from_the_start_when_a_later_project_asks_first(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    later = project.model_copy(deep=True)
    later.clips = [c for c in later.clips if c.id != "host2"]
    built = build_track_rms_caches(
        later, track_ids=["host", "guest"], unprocessed=True, defaults=defaults
    )

    profiles = cut_proof.BatchBase(project).profiles(later, built, defaults=defaults)

    assert profiles == _profile_of_whole_track(project)


def test_a_check_ending_exactly_at_the_applied_cut_is_not_served_from_the_carried_set(
    tmp_path: Path,
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    timeline = cut_proof.CarriedTimelineRms(project)
    first = timeline.caches_for(project, (40.0, 40.35), reach=6.0, defaults=defaults)
    timeline.applied(50.0)

    assert timeline.caches_for(project, (40.0, 43.99), reach=6.0, defaults=defaults) is first
    at_the_boundary = timeline.caches_for(project, (40.0, 44.0), reach=6.0, defaults=defaults)
    assert at_the_boundary is not first


def test_a_window_near_the_start_of_the_timeline_begins_at_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    defaults = load_defaults()
    timeline = cut_proof.CarriedTimelineRms(project)
    timeline.caches_for(project, (40.0, 40.35), reach=6.0, defaults=defaults)
    timeline.applied(0.0)
    starts: list[float] = []
    real = track_evidence.rms_window

    def spy(p, t, d, start, end, **kw):  # type: ignore[no-untyped-def]
        starts.append(start)
        return real(p, t, d, start, end, **kw)

    monkeypatch.setattr(track_evidence, "rms_window", spy)

    timeline.caches_for(project, (1.0, 1.35), reach=6.0, defaults=defaults)

    assert starts and min(starts) == 0.0


def test_a_rebuild_records_the_stems_so_the_next_check_does_not_rebuild(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, chained=("host",))
    _with_a_fresh_guest_stem(project)
    defaults = load_defaults()
    builds: list[int] = []
    real = cut_proof.shared_timeline_rms_caches

    def counted(p, **kw):  # type: ignore[no-untyped-def]
        builds.append(1)
        return real(p, **kw)

    monkeypatch.setattr(cut_proof, "shared_timeline_rms_caches", counted)
    timeline = cut_proof.CarriedTimelineRms(project)

    timeline.caches_for(project, (40.0, 40.35), reach=6.0, defaults=defaults)
    timeline.caches_for(project, (60.0, 60.35), reach=6.0, defaults=defaults)

    assert len(builds) == 1


# --- gated lanes and the ffprobe they may use ---------------------------------------------


def test_a_gated_lane_stamp_may_probe_but_a_second_stamp_finds_the_probe_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    project = _project(tmp_path)
    for track in project.tracks:
        track.transcript_gate = True
    spawned: list[object] = []
    real_run, real_popen = subprocess.run, subprocess.Popen

    def run(*args, **kwargs):  # type: ignore[no-untyped-def]
        spawned.append(args[:1])
        return real_run(*args, **kwargs)

    class Popen(real_popen):  # type: ignore[valid-type, misc]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            spawned.append(args[:1])
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(subprocess, "Popen", Popen)

    first = _stamp(project)
    after_first = len(spawned)
    second = _stamp(project)

    assert first == second
    assert len(spawned) == after_first  # a probe made once is not made again
