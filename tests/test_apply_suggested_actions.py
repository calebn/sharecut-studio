"""Apply suggested actions: every pending sound gets its own action in one undo step (#1434)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.edits import cut_policy, suggested_actions
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    CutIntent,
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
    audio = room(seconds=10)
    voice(audio, 0, 0.7)
    voice(audio, 9.2, 9.8)
    audio[14400:144000] = 0
    voice(audio, 1.08, 1.22)
    write_wav(media_path, audio)
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


def _layout(path: str) -> list[tuple[float, float, float]]:
    clips = load_project(Path(path)).clips
    return [(c.timeline_start, c.source_start, c.source_end) for c in clips]


def _pending(path: str) -> list[str]:
    return sorted(d.id for d in load_project(Path(path)).edit_decisions if not d.applied)


def test_one_step_cuts_lowers_and_leaves_each_by_its_own_action(
    tmp_path, sample_wav, monkeypatch
) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
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
    assert [
        (r.track_id, r.start_s, r.end_s, r.action)
        for r in load_project(Path(path)).editorial.sound_actions
    ] == [("host", 3.0, 3.3, "lower"), ("host", 5.0, 5.3, "leave")]


def test_a_laugh_nobody_talks_over_is_left(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: False)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    assert out["lowered_to_leave"] == 1
    assert "lower" not in out["applied"]
    assert not any(c.mute_regions for c in load_project(Path(path)).clips)


@pytest.mark.parametrize("error", [OSError("stem unreadable"), ValueError("bad span")])
def test_an_unreadable_peer_check_leaves_the_sound_pending_not_recorded(
    tmp_path, sample_wav, monkeypatch, error
) -> None:
    from podcast_mcp.edits import cut_safety

    path = _project(tmp_path, sample_wav)

    def unreadable(*_a, **_k):
        raise error

    monkeypatch.setattr(cut_safety, "assess_cross_track_speech", unreadable)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions(["laugh"])
    assert out["held"] == ["laugh"]
    assert out["lowered_to_leave"] == 0
    assert "laugh" in _pending(path)
    saved = load_project(Path(path))
    assert saved.editorial.sound_actions == []
    assert not any(c.mute_regions for c in saved.clips)


def test_lowering_a_pending_remove_uses_the_mute_policy_row(
    tmp_path, sample_wav, monkeypatch
) -> None:
    from podcast_mcp.edits import cut_placement, cut_safety

    path = _project(tmp_path, sample_wav)
    service = EditService(ProjectWorkspace.open(path))
    hold = cut_placement.CutScopeHold("laugh", (), "source_geometry")
    monkeypatch.setattr(cut_safety, "complete_effect_placement", lambda *a, **k: hold)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    mute_key = ("source_geometry", "mute")
    ripple_policy = cut_policy.CUT_ACTION_TABLE[("source_geometry", "ripple")]
    mute_policy = cut_policy.CUT_ACTION_TABLE[mute_key]

    held = service.apply_suggested_actions(["laugh"], overrides={"laugh": "lower"})
    assert held["held"] == ["laugh"]
    assert "laugh" in _pending(path)

    with pytest.raises(KeyError, match="source_geometry"):
        monkeypatch.delitem(cut_policy.CUT_ACTION_TABLE, mute_key)
        service.apply_suggested_actions(["laugh"], overrides={"laugh": "lower"})
    assert "laugh" in _pending(path)
    monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, mute_key, mute_policy)
    monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, mute_key, replace(mute_policy, action="cut"))
    applied = service.apply_suggested_actions(["laugh"], overrides={"laugh": "lower"})
    assert applied["applied"] == {"lower": 1}
    assert applied["held"] == []
    assert "laugh" not in _pending(path)
    assert cut_policy.CUT_ACTION_TABLE[("source_geometry", "ripple")] == ripple_policy


def test_the_whole_batch_is_one_undo_step(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    ws = ProjectWorkspace.open(path)
    EditService(ws).apply_suggested_actions()
    after = load_project(Path(path))
    rows = [(r.track_id, r.start_s, r.end_s, r.action) for r in after.editorial.sound_actions]
    assert rows
    HistoryService(ws).undo()
    assert _pending(path) == ["laugh", "manual", "um", "word"]
    assert not any(c.mute_regions for c in load_project(Path(path)).clips)
    assert load_project(Path(path)).editorial.sound_actions == []
    HistoryService(ws).redo()
    redone = load_project(Path(path))
    assert [
        (r.track_id, r.start_s, r.end_s, r.action) for r in redone.editorial.sound_actions
    ] == rows


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


def test_one_sound_can_change_after_the_batch_without_undoing_the_others(
    tmp_path, sample_wav, monkeypatch
) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    ws = ProjectWorkspace.open(path)
    first = EditService(ws).apply_suggested_actions()
    assert first["applied"] == {"lower": 1, "leave": 1, "cut": 1}
    cut_layout = _layout(path)

    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions(
        overrides={"um": "leave"}, revise=True
    )

    assert out["applied"] == {"lower": 1, "leave": 2}
    project = load_project(Path(path))
    assert _layout(path) != cut_layout
    assert _layout(path) == [(0.0, 0.0, 10.0)]
    assert [(r.start_s, r.gain_db) for c in project.clips for r in c.mute_regions] == [(3.0, -12.0)]
    assert _pending(path) == ["manual"]
    # Revising steps back to before the batch, so a sound is recorded once, and a spoken
    # filler left by hand is not a sound the pipeline would propose again.
    assert [(r.start_s, r.action) for r in project.editorial.sound_actions] == [
        (3.0, "lower"),
        (5.0, "leave"),
    ]
    # The revised batch is again one undo step back to the proposals.
    HistoryService(ProjectWorkspace.open(path)).undo()
    assert _pending(path) == ["laugh", "manual", "um", "word"]
    assert not any(c.mute_regions for c in load_project(Path(path)).clips)


def _batch_sounds(path: str) -> dict[str, dict]:
    entries = HistoryService(ProjectWorkspace.open(path)).list_entries().entries
    batch = [e for e in entries if e.operation == "apply_suggested_actions"][-1]
    assert batch.params is not None
    return {row["id"]: row for row in batch.params["sounds"]}


def test_the_batch_entry_remembers_each_sound_so_a_client_can_list_it(
    tmp_path, sample_wav, monkeypatch
) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions()

    sounds = _batch_sounds(path)

    assert sorted(sounds) == ["laugh", "um", "word"]
    assert sounds["um"] == {
        "id": "um",
        "label": sounds["um"]["label"],
        "track_id": "host",
        "timeline_start": 1.0,
        "action": "cut",
    }
    assert sounds["laugh"]["action"] == "lower"
    assert sounds["laugh"]["timeline_start"] == 3.0
    assert sounds["um"]["label"] and sounds["um"]["label"] != "filler:um"


def test_the_batch_entry_lists_a_laugh_nobody_talks_over_as_left(
    tmp_path, sample_wav, monkeypatch
) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: False)
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions()

    assert _batch_sounds(path)["laugh"]["action"] == "leave"


def test_a_revised_batch_lists_its_new_actions(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions(
        overrides={"um": "leave"}, revise=True
    )

    sounds = _batch_sounds(path)

    assert sounds["um"]["action"] == "leave"
    assert sounds["laugh"]["action"] == "lower"
    assert sounds["um"]["timeline_start"] == 1.0


def test_revise_that_applies_nothing_keeps_the_batch(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions(["um"])
    applied_layout = _layout(path)
    monkeypatch.setattr(
        "podcast_mcp.services.document.edit.apply_suggested_to_project", lambda *_, **__: None
    )
    with pytest.raises(Exception, match="Nothing changed"):
        EditService(ProjectWorkspace.open(path)).apply_suggested_actions(
            overrides={"um": "cut"}, revise=True
        )
    assert _layout(path) == applied_layout


def test_revise_refuses_once_something_else_changed(tmp_path, sample_wav, monkeypatch) -> None:
    path = _project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    EditService(ProjectWorkspace.open(path)).reject(["manual"])
    with pytest.raises(Exception, match="Nothing to revise"):
        EditService(ProjectWorkspace.open(path)).apply_suggested_actions(
            overrides={"um": "leave"}, revise=True
        )
    with pytest.raises(Exception, match="not part of the latest batch"):
        fresh = _project(tmp_path / "again", sample_wav)
        EditService(ProjectWorkspace.open(fresh)).apply_suggested_actions()
        EditService(ProjectWorkspace.open(fresh)).apply_suggested_actions(
            overrides={"nope": "leave"}, revise=True
        )


def test_an_unknown_action_is_refused(tmp_path, sample_wav) -> None:
    path = _project(tmp_path, sample_wav)
    with pytest.raises(Exception, match="unknown action"):
        EditService(ProjectWorkspace.open(path)).apply_suggested_actions(overrides={"um": "mute"})


def test_a_lowered_region_renders_at_its_gain_and_a_mute_still_renders_silent(tmp_path) -> None:
    import shutil
    import subprocess

    import numpy as np

    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.engines.mute_regions import mute_spans_for_source_window

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
    from podcast_mcp.edits import cut_safety as guard

    path = _project(tmp_path, sample_wav)
    peer_speaking = guard.ResolvedCutScope(
        "peer_speech", guard.SpeechEnergyGuardResult(blocking_track_ids=("guest",), action="review")
    )
    monkeypatch.setattr(guard, "resolve_cut_scope", lambda *a, **k: peer_speaking)
    held_ids: list[str] = []
    service = EditService(ProjectWorkspace.open(path))
    service.approve(["um"], held_out=[])  # the ordinary Approve still holds it
    assert "um" in _pending(path)
    automatic = service.apply_suggested_actions(["um"])
    assert automatic["applied"] == {}
    assert automatic["held"] == ["um"]
    assert "um" in _pending(path)

    key = ("peer_speech", "ripple")
    review = cut_policy.CUT_ACTION_TABLE[key]
    before_model = service.ws.project.model_dump(mode="json")
    before_bytes = Path(path).read_bytes()
    monkeypatch.delitem(cut_policy.CUT_ACTION_TABLE, key)
    with pytest.raises(KeyError, match="peer_speech"):
        service.apply_suggested_actions(["um"])
    assert service.ws.project.model_dump(mode="json") == before_model
    assert Path(path).read_bytes() == before_bytes

    monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, key, review)
    monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, key, replace(review, action="cut"))
    changed = service.apply_suggested_actions(["um"])
    assert changed["applied"] == {"cut": 1}
    assert "um" not in _pending(path)

    HistoryService(service.ws).undo()
    monkeypatch.setitem(cut_policy.CUT_ACTION_TABLE, key, review)
    out = service.apply_suggested_actions(["um"], application_intent=CutIntent.HUMAN_BOUNDARIES)
    assert out["applied"] == {"cut": 1}
    assert out["cut_over_speaker"] == 1
    assert out["held"] == held_ids
    assert "um" not in _pending(path)


def test_a_lowered_span_beside_a_mute_keeps_the_mute_and_does_not_widen_it(
    tmp_path, sample_wav, monkeypatch
) -> None:
    from podcast_mcp.engines.mute_regions import mute_spans_for_source_window

    path = _project(tmp_path, sample_wav)
    proj = load_project(Path(path))
    proj.clips[0].mute_regions = [ClipMuteRegion(start_s=2.8, end_s=3.1)]
    save_project(proj, Path(path))
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)

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
    from podcast_mcp.edits import cut_safety as guard

    path = _project(tmp_path, sample_wav)
    bleed = guard.ResolvedCutScope("speaker_bleed")
    monkeypatch.setattr(guard, "resolve_cut_scope", lambda *a, **k: bleed)
    service = EditService(ProjectWorkspace.open(path))
    automatic = service.apply_suggested_actions(["um"])
    assert automatic["applied"] == {}
    assert automatic["held"] == ["um"]
    out = service.apply_suggested_actions(["um"], application_intent=CutIntent.HUMAN_BOUNDARIES)
    assert out["applied"] == {"cut": 1}
    assert out["cut_over_speaker"] == 1
