"""Apply suggested actions: every pending sound gets its own action in one undo step (#1434)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits import suggested_actions
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.edit import EditService
from podcast_mcp.services.document.history import HistoryService


def _decision(did: str, reason: str, start: float) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=start + 0.3,
        reason=reason,
        applied=False,
    )


def _project(tmp_path, sample_wav) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    media_path = Path(path).parent / "raw" / "host.wav"
    media_path.write_bytes(sample_wav.read_bytes())
    proj = load_project(Path(path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    proj.edit_decisions = [
        _decision("um", "filler:um", 1.0),
        _decision("laugh", "filler:acoustic:likely_laugh", 3.0),
        _decision("word", "filler:acoustic:possible_word", 5.0),
        _decision("manual", "nl:topic", 7.0),
    ]
    save_project(proj, Path(path))
    return path


def _pending(path: str) -> list[str]:
    return sorted(d.id for d in load_project(Path(path)).edit_decisions if not d.applied)


def test_one_step_cuts_lowers_and_leaves_each_by_its_own_action(
    tmp_path, sample_wav, monkeypatch
) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: True)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    assert out["applied"] == {"lower": 1, "leave": 1, "cut": 1}
    assert out["cut_over_speaker"] == 0
    assert out["held"] == []
    assert _pending(path) == ["manual"]
    regions = {
        (r.start_s, r.end_s, r.gain_db)
        for clip in load_project(Path(path)).clips
        for r in clip.mute_regions
    }
    assert regions == {(3.0, 3.3, -12.0)}


def test_a_laugh_nobody_talks_over_is_left(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: False)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    assert out["lowered_to_leave"] == 1
    assert "lower" not in out["applied"]
    assert not any(c.mute_regions for c in load_project(Path(path)).clips)


def test_the_whole_batch_is_one_undo_step(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: True)
    ws = ProjectWorkspace.open(path)
    EditService(ws).apply_suggested_actions()
    HistoryService(ws).undo()
    assert _pending(path) == ["laugh", "manual", "um", "word"]
    assert not any(c.mute_regions for c in load_project(Path(path)).clips)


def test_an_override_changes_one_sound_and_ids_narrow_the_batch(
    tmp_path, sample_wav, monkeypatch
) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: True)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions(
        ["um", "word"], overrides={"um": "leave"}
    )
    assert out["applied"] == {"leave": 2}
    assert _pending(path) == ["laugh", "manual"]


def test_an_unknown_action_is_refused(tmp_path, sample_wav) -> None:
    path = _project(tmp_path, sample_wav)
    with pytest.raises(Exception, match="unknown action"):
        EditService(ProjectWorkspace.open(path)).apply_suggested_actions(overrides={"um": "mute"})


def test_a_lowered_region_renders_at_its_gain_and_a_mute_still_renders_silent(tmp_path) -> None:
    import shutil
    import subprocess

    import numpy as np

    from podcast_mcp.edits.mute_regions import mute_spans_for_source_window
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not installed")
    clip = Clip(id="c", track_id="host", source_start=0.0, source_end=3.0, timeline_start=0.0)
    clip.mute_regions = [
        ClipMuteRegion(start_s=1.0, end_s=1.5, fade_out_ms=20, fade_in_ms=20, gain_db=-12.0),
        ClipMuteRegion(start_s=2.0, end_s=2.5, fade_out_ms=20, fade_in_ms=20),
    ]
    spans = mute_spans_for_source_window(clip, 0.0, 3.0)
    chain = FFmpegEngine()._mute_chain(3.0, spans, sample_rate=16000)
    out = tmp_path / "out.f32"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000:duration=3",
            "-af",
            ",".join(chain),
            "-f",
            "f32le",
            str(out),
            "-y",
        ],
        check=True,
    )
    audio = np.fromfile(out, dtype="<f4")

    def rms(lo: float, hi: float) -> float:
        return float(np.sqrt(np.mean(audio[int(lo * 16000) : int(hi * 16000)] ** 2)))

    loud = rms(0.2, 0.8)
    assert rms(1.1, 1.4) / loud == pytest.approx(10 ** (-12 / 20), rel=0.05)
    assert rms(2.1, 2.4) / loud < 0.001
    assert rms(1.6, 1.9) / loud == pytest.approx(1.0, rel=0.05)


def test_a_cut_the_guard_holds_for_another_speaker_applies_as_a_session_ripple_and_is_counted(
    tmp_path, sample_wav, monkeypatch
) -> None:
    from podcast_mcp.edits import speech_energy_guard as guard

    path = _project(tmp_path, sample_wav)
    peer_speaking = guard.ResolvedCutScope(
        "peer_speech", guard.SpeechEnergyGuardResult(blocking_track_ids=("guest",), action="review")
    )
    monkeypatch.setattr(guard, "resolve_cut_scope", lambda *a, **k: peer_speaking)
    held_ids: list[str] = []
    service = EditService(ProjectWorkspace.open(path))
    service.approve(["um"], held_out=[])  # the ordinary Approve still holds it
    assert "um" in _pending(path)
    out = service.apply_suggested_actions(["um"])
    assert out["applied"] == {"cut": 1}
    assert out["cut_over_speaker"] == 1
    assert out["held"] == held_ids
    assert "um" not in _pending(path)


def test_a_lowered_span_beside_a_mute_keeps_the_mute_and_does_not_widen_it(
    tmp_path, sample_wav, monkeypatch
) -> None:
    from podcast_mcp.edits.mute_regions import mute_spans_for_source_window

    path = _project(tmp_path, sample_wav)
    proj = load_project(Path(path))
    proj.clips[0].mute_regions = [ClipMuteRegion(start_s=2.8, end_s=3.1)]
    save_project(proj, Path(path))
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_: True)

    EditService(ProjectWorkspace.open(path)).apply_suggested_actions(["laugh"])

    clip = load_project(Path(path)).clips[0]
    assert sorted((r.start_s, round(r.end_s, 3), r.gain_db) for r in clip.mute_regions) == [
        (2.8, 3.1, None),
        (3.1, 3.3, -12.0),
    ]
    gains = [
        (round(e.start, 3), round(e.end, 3), e.gain)
        for e in mute_spans_for_source_window(clip, 0.0, 10.0)
    ]
    assert gains[0][:2] == (2.8, 3.1) and gains[0][2] == 0.0
    assert gains[1][:2] == (3.1, 3.3) and gains[1][2] > 0.0


def test_a_lowered_region_takes_no_fill() -> None:
    from podcast_mcp.models import RoomToneFill

    with pytest.raises(ValueError, match="takes no room-tone fill"):
        ClipMuteRegion(
            start_s=1.0, end_s=2.0, gain_db=-6.0, fill=RoomToneFill(start_s=0.0, end_s=1.0)
        )


def test_a_speaker_bleed_hold_also_applies_as_a_session_ripple(
    tmp_path, sample_wav, monkeypatch
) -> None:
    from podcast_mcp.edits import speech_energy_guard as guard

    path = _project(tmp_path, sample_wav)
    bleed = guard.ResolvedCutScope("speaker_bleed")
    monkeypatch.setattr(guard, "resolve_cut_scope", lambda *a, **k: bleed)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions(["um"])
    assert out["applied"] == {"cut": 1}
    assert out["cut_over_speaker"] == 1
