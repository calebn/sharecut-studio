"""An approval reuses the check of a cut whose neighbourhood did not change (#1958)."""

from __future__ import annotations

import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import cut_application, cut_policy, cut_safety, verdict_cache
from podcast_mcp.edits.cut_application import approve_edits, precompute_verdicts
from podcast_mcp.edits.cut_speech import LaneSourceExtent
from podcast_mcp.models import (
    Clip,
    CutIntent,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from source_review_helpers import _cut

SR = 16_000
SECONDS = 40
IDS = ["near", "far"]


def _project(tmp_path: Path, *, cuts=((5.0, 5.4), (30.0, 30.4))) -> EpisodeProject:
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    noise = np.random.default_rng(1).normal(0.0, 0.0003, SECONDS * SR)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((noise * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("verdict cache", str(tmp_path))
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
    project.edit_decisions = [_cut(i, a, b) for i, (a, b) in zip(IDS, cuts, strict=True)]
    return project


@pytest.fixture
def cache_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    monkeypatch.setattr(verdict_cache, "WINDOW_SEC", 2.0)


def _spy_observations(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    seen: list[str] = []
    real = cut_safety.observe_source_cut

    def spy(project, edit, **kwargs):
        seen.append(edit.id)
        return real(project, edit, **kwargs)

    monkeypatch.setattr(cut_safety, "observe_source_cut", spy)
    return seen


def _approve(project: EpisodeProject) -> list:
    held: list = []
    approve_edits(project, IDS, defaults=load_defaults(), held_out=held, asked_out=[])
    return held


def test_the_cache_is_off_unless_asked_for(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _project(tmp_path)
    assert precompute_verdicts(project, IDS, defaults=load_defaults()) == 0
    assert len(verdict_cache._STORE) == 0


def test_a_precomputed_cut_is_not_observed_again_and_decides_the_same(
    tmp_path: Path, cache_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    plain_dir, cached_dir = tmp_path / "plain", tmp_path / "cached"
    monkeypatch.delenv(verdict_cache.ENABLE_ENV)
    plain = _project(plain_dir)
    _approve(plain)

    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    project = _project(cached_dir)
    assert precompute_verdicts(project, IDS, defaults=load_defaults()) == 2
    assert len(verdict_cache._STORE) == 2
    seen = _spy_observations(monkeypatch)
    _approve(project)

    assert seen == []
    assert [(c.source_start, c.source_end, c.timeline_start) for c in project.clips] == [
        (c.source_start, c.source_end, c.timeline_start) for c in plain.clips
    ]
    assert [e.id for e in project.edit_decisions] == [e.id for e in plain.edit_decisions]


def test_a_cut_beside_another_is_precomputed_as_the_approval_will_see_it(
    tmp_path: Path, cache_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    cuts = ((5.0, 5.4), (6.0, 6.4))
    monkeypatch.delenv(verdict_cache.ENABLE_ENV)
    plain = _project(tmp_path / "plain", cuts=cuts)
    _approve(plain)

    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    project = _project(tmp_path / "cached", cuts=cuts)
    precompute_verdicts(project, IDS, defaults=load_defaults())
    seen = _spy_observations(monkeypatch)
    _approve(project)
    assert seen == []
    assert [(c.source_start, c.source_end, c.timeline_start) for c in project.clips] == [
        (c.source_start, c.source_end, c.timeline_start) for c in plain.clips
    ]


def test_every_input_of_the_check_changes_the_key(
    tmp_path: Path, cache_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    defaults = load_defaults()

    def key(**over):
        args = {
            "defaults": defaults,
            "manual": False,
            "batch": (),
            "span": (5.0, 5.4),
        }
        return verdict_cache.verdict_key(project, edit, **{**args, **over})

    base = key()
    assert base is not None and key() == base
    assert key(manual=True) != base
    assert key(span=(5.0, 5.5)) != base
    assert (
        key(defaults={**defaults, "tighten": {**defaults["tighten"], "filler_pad_mode": "x"}})
        != base
    )

    project.tracks[0].gain_db = -3.0
    assert key() != base
    project.tracks[0].gain_db = 0.0
    assert key() == base

    project.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=4, timeline_start=0),
        Clip(id="b", track_id="host", source_start=4, source_end=SECONDS, timeline_start=4),
    ]
    joined = key()
    assert joined != base
    project.clips[1].fade_in_ms = 10
    assert key() != joined
    project.clips[1].fade_in_ms = 0
    project.clips[0].fade_in_ms = 10
    assert key() == joined  # the start of the recording is outside the window
    project.clips[0].fade_in_ms = 0

    far = project.clips[0].model_copy(
        update={"id": "far", "source_start": 0, "source_end": 3, "timeline_start": 35.0}
    )
    project.clips.append(far)
    assert key() != base  # the same recording plays again somewhere else


def test_a_cut_far_from_the_window_does_not_change_the_key(tmp_path: Path, cache_on: None) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": (5.0, 5.4)}
    base = verdict_cache.verdict_key(project, edit, **kwargs)
    project.clips = [
        Clip(id="host", track_id="host", source_start=0, source_end=30, timeline_start=0),
        Clip(id="tail", track_id="host", source_start=30.4, source_end=40, timeline_start=30),
    ]
    assert verdict_cache.verdict_key(project, edit, **kwargs) == base


def test_a_changed_recording_is_not_served_from_the_cache(
    tmp_path: Path, cache_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    precompute_verdicts(project, IDS, defaults=load_defaults())
    path = tmp_path / "raw" / "host.wav"
    data = path.read_bytes()
    path.write_bytes(data[:-2] + b"\x01\x00")
    seen = _spy_observations(monkeypatch)
    _approve(project)
    assert sorted(seen) == ["far", "near"]


def test_an_outcome_read_through_an_unreadable_file_is_not_remembered() -> None:
    with verdict_cache.recording() as marks:
        verdict_cache.mark_unstable()
    entry = verdict_cache.CachedVerdict(None, None, "", "")  # type: ignore[arg-type]
    verdict_cache.store("k", entry, marks)
    assert verdict_cache.lookup("k") is None
    verdict_cache.store("k", entry, [])
    assert verdict_cache.lookup("k") is entry


def test_verify_mode_rechecks_every_hit_and_agrees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(verdict_cache.VERIFY_ENV, "1")
    monkeypatch.setattr(verdict_cache, "WINDOW_SEC", 2.0)
    project = _project(tmp_path)
    precompute_verdicts(project, IDS, defaults=load_defaults())
    seen = _spy_observations(monkeypatch)
    _approve(project)
    assert set(seen) == {"far", "near"}


def test_verify_mode_fails_when_an_entry_is_wrong(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(verdict_cache.VERIFY_ENV, "1")
    monkeypatch.setattr(verdict_cache, "WINDOW_SEC", 2.0)
    project = _project(tmp_path)
    precompute_verdicts(project, IDS, defaults=load_defaults())
    with verdict_cache._STORE.lock:
        for key in list(verdict_cache._STORE._data):
            good = verdict_cache._STORE._data[key]
            verdict_cache._STORE._data[key] = verdict_cache.CachedVerdict(
                good.observation, good.outcome, "tampered", good.pads
            )
    with pytest.raises(AssertionError, match="differs from a full check"):
        _approve(project)


def test_cut_application_names_the_cache_module() -> None:
    assert cut_application.verdict_cache is verdict_cache


def test_the_window_covers_the_breath_context_it_reads() -> None:
    assert verdict_cache.WINDOW_SEC >= 5.0 + verdict_cache.FADE_REACH_SEC


def test_the_production_window_sees_a_change_four_seconds_away(tmp_path: Path) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": (5.0, 5.4)}
    base = verdict_cache.verdict_key(project, edit, **kwargs)
    project.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=9.4, timeline_start=0),
        Clip(id="b", track_id="host", source_start=9.4, source_end=SECONDS, timeline_start=9.4),
    ]
    assert verdict_cache.verdict_key(project, edit, **kwargs) != base


def test_a_batch_cut_changes_the_key_only_when_it_maps_into_the_window(tmp_path: Path) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "span": (5.0, 5.4)}
    base = verdict_cache.verdict_key(project, edit, batch=(), **kwargs)
    near = (LaneSourceExtent("host", 6.0, 6.4),)
    far = (LaneSourceExtent("host", 35.0, 35.4),)
    elsewhere = (LaneSourceExtent("host", 36.0, 36.4),)
    assert verdict_cache.verdict_key(project, edit, batch=near, **kwargs) != base
    assert verdict_cache.verdict_key(project, edit, batch=far, **kwargs) == (
        verdict_cache.verdict_key(project, edit, batch=elsewhere, **kwargs)
    )


def test_the_policy_tables_are_part_of_the_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": (5.0, 5.4)}
    base = verdict_cache.verdict_key(project, edit, **kwargs)
    monkeypatch.setattr(cut_policy, "CUT_EDGE_CHECKS", {})
    assert verdict_cache.verdict_key(project, edit, **kwargs) != base


def test_a_changed_word_near_the_cut_changes_the_key(tmp_path: Path) -> None:
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hello", start=4.6, end=5.0)])
    ]
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": (5.0, 5.4)}
    base = verdict_cache.verdict_key(project, edit, **kwargs)
    project.transcripts[0].words[0].text = "hullo"
    assert verdict_cache.verdict_key(project, edit, **kwargs) != base


def test_key_parts_name_the_input_that_moved_the_key(tmp_path: Path) -> None:
    project = _project(tmp_path)
    edit = project.edit_decisions[0]
    kwargs = {"defaults": load_defaults(), "manual": False, "batch": (), "span": (5.0, 5.4)}
    base = verdict_cache.key_parts(project, edit, **kwargs)
    assert base is not None and "heard" in base
    project.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=4, timeline_start=0),
        Clip(id="b", track_id="host", source_start=4, source_end=SECONDS, timeline_start=4),
    ]
    moved = verdict_cache.key_parts(project, edit, **kwargs)
    assert moved is not None
    assert {name for name in base if base[name] != moved[name]} == {"heard"}


def test_the_host_approval_reuses_the_checks_warmed_in_the_background(
    tmp_path: Path, cache_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.document.edit import EditService

    project = _project(tmp_path)
    for edit in project.edit_decisions:
        edit.review_required = True
    ws = SimpleNamespace(project=project, effective_config=load_defaults)
    assert EditService(ws).warm_approval_checks() == 2  # type: ignore[arg-type]
    seen = _spy_observations(monkeypatch)
    approve_edits(
        project,
        IDS,
        defaults=load_defaults(),
        held_out=[],
        asked_out=[],
        application_intent=CutIntent.HUMAN_BOUNDARIES,
    )
    assert seen == []


def test_a_programmatic_check_is_not_reused_by_the_host_approval(
    tmp_path: Path, cache_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The intent decides how a cut is checked, so a check made for one is never served to the other.
    project = _project(tmp_path)
    precompute_verdicts(project, IDS, defaults=load_defaults())
    seen = _spy_observations(monkeypatch)
    approve_edits(
        project,
        IDS,
        defaults=load_defaults(),
        held_out=[],
        asked_out=[],
        application_intent=CutIntent.HUMAN_BOUNDARIES,
    )
    assert sorted(seen) == sorted(IDS)


def test_the_background_warm_stops_when_an_approval_is_running(
    tmp_path: Path, cache_on: None
) -> None:
    project = _project(tmp_path)
    with verdict_cache.approving():
        assert (
            precompute_verdicts(project, IDS, defaults=load_defaults(), yield_to_approval=True) == 0
        )
        assert len(verdict_cache._STORE) == 0
    assert not verdict_cache.approval_running()
    precompute_verdicts(project, IDS, defaults=load_defaults(), yield_to_approval=True)
    assert len(verdict_cache._STORE) == 2
