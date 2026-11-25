"""Cut scope reads speaker profiles once per run, not once or twice per candidate (#2364)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_safety import ResolvedCutScope, SpeakerScopeSnapshot, resolve_cut_scope
from podcast_mcp.edits.tighten import gate
from podcast_mcp.edits.tighten.candidate import _speaker_cut_context, _SpeakerCutContext
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

PROFILES = {"host": object()}
CONFIG = object()


def _two_track() -> EpisodeProject:
    p = EpisodeProject.create("seg", "/tmp/seg")
    p.tracks = [
        Track(
            id=track_id,
            label=track_id.title(),
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"/tmp/seg/raw/{track_id}.wav", duration_sec=10.0),
        )
        for track_id in ("host", "guest")
    ]
    p.clips = [
        Clip(
            id=f"{track_id[0]}1",
            track_id=track_id,
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
        for track_id in ("host", "guest")
    ]
    return p


class _Loads:
    def __init__(self, profiles=PROFILES) -> None:
        self.profiles = profiles
        self.profile_loads = 0
        self.context_loads = 0
        self.assessed: list[tuple[object, object]] = []

    def load_all_profiles(self, _project):
        self.profile_loads += 1
        return self.profiles

    def load_transcript_context(self, _workspace):
        self.context_loads += 1
        return type("Ctx", (), {"speaker_id": CONFIG})()

    def assess(
        self, _project, _track, _start, _end, cfg, backend=None, *, profiles=None, role_memo=None
    ):
        self.assessed.append((cfg, profiles))
        return {"role": "bleed"}


@pytest.fixture
def loads(monkeypatch: pytest.MonkeyPatch) -> _Loads:
    spy = _Loads()
    monkeypatch.setattr("podcast_mcp.engines.speaker_id.load_all_profiles", spy.load_all_profiles)
    monkeypatch.setattr(
        "podcast_mcp.project.transcript_context.load_transcript_context",
        spy.load_transcript_context,
    )
    monkeypatch.setattr("podcast_mcp.engines.speaker_id.assess_speaker_cut_role", spy.assess)
    return spy


def test_without_a_snapshot_the_loaded_profiles_reach_the_role_check(loads: _Loads) -> None:
    resolved = resolve_cut_scope(_two_track(), "host", 2.0, 2.5, defaults=load_defaults())
    assert resolved == ResolvedCutScope("speaker_bleed")
    assert (loads.profile_loads, loads.context_loads) == (1, 1)
    # The role check gets the profiles already loaded, so it does not load them again.
    assert loads.assessed == [(CONFIG, PROFILES)]


def test_a_snapshot_is_used_without_loading(loads: _Loads) -> None:
    project = _two_track()
    snapshot = SpeakerScopeSnapshot(profiles=PROFILES, config=CONFIG)
    for start in (1.0, 2.0, 3.0):
        resolved = resolve_cut_scope(
            project, "host", start, start + 0.5, defaults=load_defaults(), speaker=snapshot
        )
        assert resolved == ResolvedCutScope("speaker_bleed")
    assert (loads.profile_loads, loads.context_loads) == (0, 0)
    assert loads.assessed == [(CONFIG, PROFILES)] * 3


def test_an_empty_snapshot_skips_the_role_check(loads: _Loads, monkeypatch) -> None:
    profile = LevelProfile(room_db=-60.0, speech_db=-15.0, loud_db=-15.0)
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.track_level_profile", lambda *_a, **_k: profile
    )
    with patch("podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db", return_value=-60.0):
        resolved = resolve_cut_scope(
            _two_track(),
            "host",
            2.0,
            2.5,
            defaults=load_defaults(),
            speaker=SpeakerScopeSnapshot(profiles={}, config=None),
        )
    assert isinstance(resolved, ResolvedCutScope)
    assert resolved.cause == "session_clear"
    assert (loads.profile_loads, loads.context_loads, loads.assessed) == (0, 0, [])


def test_tighten_passes_its_run_snapshot_to_the_scope(loads: _Loads) -> None:
    project = _two_track()
    context = _speaker_cut_context(project)
    assert (loads.profile_loads, loads.context_loads) == (1, 1)
    for start in (1.0, 2.0, 3.0):
        resolved = gate._cut_scope(
            project,
            "host",
            start,
            start + 0.5,
            peer_scoped=True,
            defaults=load_defaults(),
            speaker_context=context,
        )
        assert resolved == ResolvedCutScope("speaker_bleed")
    assert (loads.profile_loads, loads.context_loads) == (1, 1)
    assert loads.assessed == [(CONFIG, PROFILES)] * 3


def test_a_snapshot_that_failed_to_load_is_not_trusted(monkeypatch) -> None:
    """A failed run snapshot reads as "no profiles"; the scope loads again so a failure still counts."""

    def boom(_project):
        raise RuntimeError("profiles unreadable")

    monkeypatch.setattr("podcast_mcp.engines.speaker_id.load_all_profiles", boom)
    context = _speaker_cut_context(_two_track())
    assert context == _SpeakerCutContext(None, {}, loaded=False)
    marked: list[bool] = []
    monkeypatch.setattr(
        "podcast_mcp.edits.verdict_cache.mark_unstable", lambda: marked.append(True)
    )
    profile = LevelProfile(room_db=-60.0, speech_db=-15.0, loud_db=-15.0)
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.track_level_profile", lambda *_a, **_k: profile
    )
    with patch("podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db", return_value=-60.0):
        gate._cut_scope(
            _two_track(),
            "host",
            2.0,
            2.5,
            peer_scoped=True,
            defaults=load_defaults(),
            speaker_context=context,
        )
    assert marked == [True]
