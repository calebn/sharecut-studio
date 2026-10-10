from __future__ import annotations

import numpy as np
import pytest

from pause_policy_public_helpers import (
    RATE,
    configure,
    defaults,
    pause,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.session_air import GeometricPause, MeasuredPause, SessionAir
from podcast_mcp.models import Clip, Transcript, TranscriptWord, load_project
from podcast_mcp.services.document import EditService


def _recording(tmp_path, content: str = "quiet"):
    result = project(tmp_path)
    audio = room(seed=1220)
    for lo, hi in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
        voice(audio, lo, hi)
    lo, hi = round(4.94 * RATE), round(5 * RATE)
    if content == "breath":
        audio[lo:hi] += np.random.default_rng(1221).normal(0, 10 ** (-52 / 20), hi - lo)
    if content == "low_band":
        audio[lo:hi] += 10 ** (-52 / 20) * np.sin(2 * np.pi * 140 * np.arange(hi - lo) / RATE)
    write_wav(tmp_path / "raw" / "host.wav", audio)
    result.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
                TranscriptWord(text="reference", start=5.4, end=5.8),
            ],
        )
    ]
    return result


def test_clean_collar_uses_actual_kept_voice_without_guard_refund(tmp_path):
    result = _recording(tmp_path)
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    guards = air.sounds_in(4.7, 5.2)
    observed = air.pause_observation(4.7, 5.2, acoustic=True)

    assert isinstance(guards, list)
    assert any(sound.lo < 5 <= sound.hi for sound in guards)
    assert isinstance(observed, MeasuredPause)
    assert min(sound.lo for sound in observed.activity if sound.hi > 5) == pytest.approx(5)
    assert air.sounds_in(4.7, 5.2) == guards


@pytest.mark.parametrize("content", ["breath", "low_band"])
def test_attached_content_cannot_be_refunded_as_word_guard(tmp_path, content):
    result = _recording(tmp_path, content)
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    observed = air.pause_observation(4.7, 5.2, acoustic=True)

    assert isinstance(observed, MeasuredPause)
    assert min(sound.lo for sound in observed.activity if sound.hi > 5) < 4.95


def test_clipped_word_guard_keeps_conservative_activity(tmp_path):
    result = _recording(tmp_path)
    result.clips[0].source_start = 4.97
    result.clips[0].timeline_start = 0
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    observed = air.pause_observation(0, 0.3, acoustic=True)

    assert isinstance(observed, MeasuredPause)
    assert min(sound.lo for sound in observed.activity) < 0


def test_short_native_collar_cannot_claim_independent_room_quiet(tmp_path):
    result = _recording(tmp_path)
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    assert isinstance(air.sounds_in(4.7, 5.2), list)
    recording = next(iter(air._recordings.values()))
    reading = recording.reading()

    corridor = recording._corridor(reading, 0.2, 5.0)
    assert corridor is not None

    assert corridor.collar(4.98, 5.0).value == "unavailable"
    assert corridor.collar(4.981, 5.0).value == "unavailable"


def test_missing_origin_voice_cache_keeps_guard_bounds(tmp_path):
    result = _recording(tmp_path)
    air = SessionAir(result)

    guards = air.sounds_in(4.7, 5.2)
    observed = air.pause_observation(4.7, 5.2, acoustic=True)

    assert isinstance(guards, list)
    assert isinstance(observed, MeasuredPause)
    assert [(sound.lo, sound.hi) for sound in observed.activity] == [
        (sound.lo, sound.hi) for sound in guards
    ]


def test_disabled_observation_never_reads_recording_room(tmp_path):
    result = _recording(tmp_path)
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    observed = air.pause_observation(0.3, 5.2, acoustic=False)

    assert isinstance(observed, GeometricPause)
    assert all(not recording._done for recording in air._recordings.values())


def test_geometric_first_word_preserves_known_release_without_room_read(tmp_path):
    result = _recording(tmp_path)
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    observed = air.pause_observation(0, 0.3, acoustic=False)

    assert isinstance(observed, GeometricPause)
    assert [(sound.lo, sound.hi) for sound in observed.activity] == [pytest.approx((0, 0.2))]
    assert all(not recording._done for recording in air._recordings.values())


def test_guard_touching_partial_replay_keeps_conservative_activity(tmp_path):
    result = _recording(tmp_path)
    result.clips.append(
        Clip(
            id="guard-replay",
            track_id="host",
            source_start=4.7,
            source_end=5.8,
            timeline_start=6,
        )
    )
    result.timeline.duration_sec = 7.1
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    guards = air.sounds_in(4.7, 5.2)
    observed = air.pause_observation(4.7, 5.2, acoustic=True)

    assert isinstance(guards, list)
    assert isinstance(observed, MeasuredPause)
    assert min(sound.lo for sound in observed.activity if sound.hi > 5) == pytest.approx(4.95)
    assert air.sounds_in(4.7, 5.2) == guards


def test_interior_only_replay_does_not_block_kept_word_refinement(tmp_path):
    result = _recording(tmp_path)
    result.clips.append(
        Clip(
            id="interior-replay",
            track_id="host",
            source_start=0.3,
            source_end=4.45,
            timeline_start=9,
        )
    )
    result.timeline.duration_sec = 13.15
    air = SessionAir(result, audio_caches=build_track_audio_caches(result, ["host"]))

    guards = air.sounds_in(4.7, 5.2)
    observed = air.pause_observation(4.7, 5.2, acoustic=True)

    assert isinstance(guards, list)
    assert isinstance(observed, MeasuredPause)
    assert min(sound.lo for sound in observed.activity if sound.hi > 5) == pytest.approx(5)
    assert air.sounds_in(4.7, 5.2) == guards


def test_saved_splice_archive_binds_finite_source_effects_before_consumption(tmp_path, monkeypatch):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    result = _recording(tmp_path)
    result.edit_decisions = [pause(start=0.3, end=4.45, gap=None)]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert (record.source_start, record.source_end) == pytest.approx((0.3, 4.45))
    assert record.params["loss_sec"] == pytest.approx(4.15)
    assert record.params["pad_samples"] == []
    assert record.params["replace_gap_sec"] is None
    effects = record.params["edge_fades"]
    assert [(edge["side"], edge["milliseconds"]) for edge in effects] == [
        ("left", 100),
        ("right", 150),
    ]
    assert [(edge["source_start"], edge["source_end"]) for edge in effects] == [
        pytest.approx((0.2, 0.3)),
        pytest.approx((4.45, 4.6)),
    ]
    assert all("recording_key" not in edge and "_media" not in edge for edge in effects)
    assert saved.clips[0].fade_out_ms == 100
    assert saved.clips[1].fade_in_ms == 150


def test_saved_whole_sound_splice_preserves_kept_samples_with_local_effects(tmp_path, monkeypatch):
    from podcast_mcp.engines.align import load_mono_window
    from podcast_mcp.engines.timeline_render import render_track_from_timeline

    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    result = _recording(tmp_path)
    audio = room(seed=1220)
    for lo, hi in ((0, 0.2), (2.9, 3.15), (3.85, 4.1), (5, 5.2), (5.4, 5.8)):
        voice(audio, lo, hi)
    write_wav(tmp_path / "raw" / "host.wav", audio)
    result.edit_decisions = [pause(start=3, end=4, gap=None)]
    ws = workspace(result)

    assert EditService(ws).approve(["pause"]) == 1

    saved = load_project(ws.path)
    record = saved.editorial.edit_log[0]
    assert 3.15 <= record.source_start <= 3.25
    assert 3.75 <= record.source_end <= 3.85
    assert [(edge["side"], edge["milliseconds"]) for edge in record.params["edge_fades"]] == [
        ("left", 0),
        ("right", 0),
    ]
    output = tmp_path / "finite-splice.wav"
    render_track_from_timeline(saved, saved.track_by_id("host"), output, {})
    removal = record.source_end - record.source_start
    for source_start, source_end, timeline_start in ((2.9, 3.15, 2.9), (3.85, 4.1, 3.85 - removal)):
        original = load_mono_window(
            tmp_path / "raw" / "host.wav",
            start_sec=source_start,
            duration_sec=source_end - source_start,
            sample_rate=RATE,
        )
        played = load_mono_window(
            output,
            start_sec=timeline_start,
            duration_sec=source_end - source_start,
            sample_rate=RATE,
        )
        np.testing.assert_allclose(played, original, atol=2 / 32768, rtol=0)
