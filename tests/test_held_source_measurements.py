from __future__ import annotations

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.edits import cut_application, cut_effects, cut_placement, cut_safety
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.batch_scope import batch_scope


def _scene(tmp_path):
    project = EpisodeProject.create("held measurements", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.clips = [
        Clip(id="target", track_id="host", source_start=0, source_end=5, timeline_start=0)
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=1.0, end=1.6),
                TranscriptWord(text="two", start=3.0, end=3.4),
            ],
        )
    ]
    audio = room(seconds=5, seed=1701, db=-70)
    voice(audio, 1, 2)
    write_wav(tmp_path / "raw/host.wav", audio)
    candidate = project.model_copy(deep=True)
    candidate.clips[0].source_start = 1.3
    candidate.clips[0].fade_in_ms = 10
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    assert len(effects) >= 3
    return project, effects


@pytest.fixture
def assessed(monkeypatch):
    calls: list[tuple[float, float]] = []
    real = cut_safety.assess_held_source

    def spy(project, track_id, start, end, **kwargs):
        calls.append((start, end))
        return real(project, track_id, start, end, **kwargs)

    monkeypatch.setattr(cut_safety, "assess_held_source", spy)
    return calls


_DEFAULTS: dict = {}


def _holds(project, effects, **kwargs):
    return cut_safety.complete_effect_acoustics(project, effects, defaults=_DEFAULTS, **kwargs)


def test_a_recording_is_looked_up_once_per_call(tmp_path, monkeypatch):
    project, effects = _scene(tmp_path)
    lookups: list[object] = []
    real = cut_safety.recording_audio_cache
    monkeypatch.setattr(
        cut_safety, "recording_audio_cache", lambda path: lookups.append(path) or real(path)
    )
    with batch_scope():
        _holds(project, effects)
    assert len(lookups) == 1


def test_a_second_call_on_the_same_project_assesses_no_window_again(tmp_path, assessed):
    project, effects = _scene(tmp_path)
    measured: cut_safety.MeasuredSources = {}
    with batch_scope():
        first = _holds(project, effects, measured=measured)
        once = len(assessed)
        second = _holds(project, effects, measured=measured)
        plain = _holds(project, effects)
    assert once == len({(e.start, e.end, e.retained) for e in effects})
    assert len(assessed) == once + len(effects)
    assert second == first == plain


def test_a_different_project_object_is_assessed_again(tmp_path, assessed):
    project, effects = _scene(tmp_path)
    measured: cut_safety.MeasuredSources = {}
    with batch_scope():
        _holds(project, effects, measured=measured)
        once = len(assessed)
        _holds(project.model_copy(deep=True), effects, measured=measured)
    assert len(assessed) == 2 * once


def test_other_defaults_are_assessed_again(tmp_path, assessed):
    project, effects = _scene(tmp_path)
    measured: cut_safety.MeasuredSources = {}
    with batch_scope():
        _holds(project, effects, measured=measured)
        once = len(assessed)
        cut_safety.complete_effect_acoustics(project, effects, defaults={}, measured=measured)
    assert len(assessed) == 2 * once


def test_a_cleared_dict_reads_an_edited_transcript(tmp_path, assessed):
    project, effects = _scene(tmp_path)
    measured: cut_safety.MeasuredSources = {}
    with batch_scope():
        before = _holds(project, effects, measured=measured)
        once = len(assessed)
        project.transcripts[0].words[0].suppressed = True
        measured.clear()
        after = _holds(project, effects, measured=measured)
        expected = _holds(project, effects)
    assert len(assessed) == once + once + len(effects)
    assert "word_edge" in before[0].detail
    assert "word_edge" not in after[0].detail
    assert before != after
    assert after == expected


def test_outside_a_batch_scope_nothing_is_shared_and_results_match(tmp_path, assessed):
    project, effects = _scene(tmp_path)
    path = effects[0].recording
    assert cut_safety.recording_audio_cache(path) is not cut_safety.recording_audio_cache(path)
    measured: cut_safety.MeasuredSources = {}
    first = _holds(project, effects, measured=measured)
    once = len(assessed)
    second = _holds(project, effects, measured=measured)
    assert len(assessed) == 2 * once
    assert second == first == _holds(project, effects)


def test_a_failed_recording_lookup_is_retried_not_remembered(tmp_path, monkeypatch):
    project, effects = _scene(tmp_path)
    real = cut_safety.recording_audio_cache
    attempts: list[object] = []

    def flaky(path):
        attempts.append(path)
        if len(attempts) == 1:
            raise OSError("gone")
        return real(path)

    monkeypatch.setattr(cut_safety, "recording_audio_cache", flaky)
    with batch_scope():
        holds = _holds(project, effects)
    assert len(attempts) == 2
    assert {h.edit_id for h in holds} <= {"remove"}


def _approve_scene(tmp_path, *, repeat_a_cut=False):
    project = EpisodeProject.create("approve sharing", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=12),
        )
    ]
    project.clips = [
        Clip(id="host", track_id="host", source_start=0, source_end=12, timeline_start=0)
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=f"w{i}", start=float(i) + 0.1, end=float(i) + 0.5)
                for i in range(12)
            ],
        )
    ]
    project.edit_decisions = [
        EditDecision(
            id=f"cut{i}",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=float(i) + 0.6,
            end=float(i) + 0.95,
            reason="nl:range",
        )
        for i in (2, 5, 8)
    ]
    if repeat_a_cut:
        # The same range twice: a held cut leaves the project untouched, so the second one
        # asks for exactly the windows the first already measured.
        project.edit_decisions.append(
            project.edit_decisions[0].model_copy(update={"id": "cut2_again"})
        )
    write_wav(tmp_path / "raw/host.wav", room(seconds=12, seed=3, db=-70))
    return ProjectWorkspace.open(save_project(project))


_REAL_APPLY = cut_application._apply_source_remove
_REAL_HOLDS = cut_application._completed_holds
_REAL_ASSESS = cut_safety.assess_held_source


def _approve(ws, monkeypatch, *, share, hold_after=None):
    real = _REAL_APPLY
    real_holds = _REAL_HOLDS
    seen: list[tuple[int, int]] = []
    cea_runs: list[int] = []
    assessed_windows: list[tuple[float, float]] = []
    real_assess = _REAL_ASSESS

    def spy(project, edit, **kwargs):
        seen.append((id(kwargs["measured"]), len(kwargs["measured"])))
        if not share:
            kwargs["measured"] = None
        return real(project, edit, **kwargs)

    def count(project, track_id, start, end, **kwargs):
        assessed_windows.append((start, end))
        return real_assess(project, track_id, start, end, **kwargs)

    def forced(before, candidate, ids, **kwargs):
        result = real_holds(before, candidate, ids, **kwargs)
        if hold_after is not None and not result:
            cea_runs.append(1)
            if len(cea_runs) > hold_after:
                return [cut_placement.CutScopeHold(e, (), "acoustic_edge") for e in ids]
        return result

    monkeypatch.setattr(cut_application, "_apply_source_remove", spy)
    monkeypatch.setattr(cut_application, "_completed_holds", forced)
    monkeypatch.setattr(cut_safety, "assess_held_source", count)
    held: list = []
    applied = cut_application.approve_edits(
        ws.project,
        [e.id for e in ws.project.edit_decisions],
        defaults=ws.effective_config(),
        held_out=held,
    )
    return applied, held, seen, assessed_windows


def test_approve_edits_shares_one_dict_per_pass_and_empties_it_at_each_apply(tmp_path, monkeypatch):
    applied, held, seen, _ = _approve(_approve_scene(tmp_path), monkeypatch, share=True)
    assert applied == 3 and not held
    assert len({dict_id for dict_id, _ in seen}) == 1
    assert [size for _, size in seen] == [0, 0, 0]


def test_consecutive_holds_reuse_what_the_first_one_measured(tmp_path, monkeypatch):
    # Distinct cuts never ask for the same window, so the scene repeats one range on purpose.
    shared = _approve(
        _approve_scene(tmp_path / "a", repeat_a_cut=True), monkeypatch, share=True, hold_after=1
    )
    plain = _approve(
        _approve_scene(tmp_path / "b", repeat_a_cut=True), monkeypatch, share=False, hold_after=1
    )
    assert shared[0] == plain[0] == 1
    assert [h.edit_id for h in shared[1]] == [h.edit_id for h in plain[1]]
    assert "cut2_again" in [h.edit_id for h in shared[1]]
    assert shared[2][0][1] == 0
    assert max(size for _, size in shared[2]) > 0
    # Sharing measures every distinct window once; without it the repeat is measured again.
    assert len(shared[3]) == len(set(shared[3]))
    assert len(shared[3]) < len(plain[3])
