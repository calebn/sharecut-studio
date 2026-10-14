from __future__ import annotations

import array
import json
import math
import wave

import pytest

from podcast_mcp.edits.pending_preview import (
    SUGGEST_REASON_SPLIT,
    SUGGEST_REASON_UNMAPPED,
    resolve_pending_preview,
)
from podcast_mcp.engines.play_audit import read_premix_trim_db
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


@pytest.fixture(autouse=True)
def _silent_pads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("podcast_mcp.edits.source_removals.filler_pad_mode", lambda: "silence")


def _project() -> EpisodeProject:
    proj = EpisodeProject.create("preview", "/tmp/preview")
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    return proj


def test_session_remove_window() -> None:
    proj = _project()
    proj.edit_decisions.append(
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=4.0,
            applied=False,
            scope="session",
        )
    )
    window = resolve_pending_preview(proj, "cut1", pad_sec=0.5)
    assert window.suggest_reason is None
    assert window.timeline_start == pytest.approx(2.0)
    assert window.timeline_end == pytest.approx(4.0)
    assert window.play_start == pytest.approx(1.5)
    assert window.play_end == pytest.approx(4.5)


def test_split_has_no_suggested_side_but_track_punch_does() -> None:
    proj = _project()
    proj.edit_decisions.append(
        EditDecision(
            id="split1",
            track_id="host",
            type=EditDecisionType.SPLIT,
            start=3.0,
            end=3.0,
            applied=False,
            timebase="timeline",
        )
    )
    proj.edit_decisions.append(
        EditDecision(
            id="punch1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            applied=False,
            scope="track",
        )
    )
    assert resolve_pending_preview(proj, "split1").suggest_reason == SUGGEST_REASON_SPLIT
    assert resolve_pending_preview(proj, "punch1").suggest_reason is None


def test_missing_pending_edit_raises() -> None:
    with pytest.raises(KeyError, match="pending edit not found"):
        resolve_pending_preview(_project(), "missing")


def test_unmappable_remove_has_no_suggested_side_but_tiny_one_does() -> None:
    proj = _project()
    proj.edit_decisions.append(
        EditDecision(
            id="away",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=20.0,
            end=21.0,
            applied=False,
            scope="session",
        )
    )
    proj.edit_decisions.append(
        EditDecision(
            id="tiny",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.01,
            applied=False,
            scope="session",
        )
    )
    assert resolve_pending_preview(proj, "away").suggest_reason == SUGGEST_REASON_UNMAPPED
    assert resolve_pending_preview(proj, "tiny").suggest_reason is None


def _rendered_project(minimal_project, edit: EditDecision):
    """Two dialogue tracks of amplitude-modulated tone, so fades and pads show in the samples.

    The guest is silent from 1 s to 4 s, so a host cut there ripples the whole session.
    A host burst at 5 s pushes the whole mix past the peak ceiling, so the premix is
    trimmed by headroom that no preview window measures on its own.
    """
    from podcast_mcp.services.app import ProjectWorkspace

    ws = ProjectWorkspace.open(minimal_project)
    root = ws.project.workspace_path()
    for index, track_id in enumerate(("host", "guest")):
        samples = array.array(
            "h",
            (
                int(
                    (30000 if track_id == "host" and 240000 <= i < 264000 else 6000)
                    * math.sin(2 * math.pi * (330 + 110 * index) * i / 48000)
                    * (0.55 + 0.45 * math.sin(2 * math.pi * 3 * i / 48000))
                )
                if track_id == "host" or not 48000 <= i < 4 * 48000
                else 0
                for i in range(6 * 48000)
            ),
        )
        with wave.open(str(root / "raw" / f"{track_id}.wav"), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(samples.tobytes())
    ws.project.tracks = [
        Track(
            id=track_id,
            label=track_id,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=6.0),
        )
        for track_id in ("host", "guest")
    ]
    ws.project.clips = [
        Clip(id=f"{tid}-full", track_id=tid, source_start=0, source_end=6, timeline_start=0)
        for tid in ("host", "guest")
    ]
    ws.project.timeline.duration_sec = 6.0
    ws.project.edit_decisions = [edit]
    ws.save()
    return ws


def _pcm(path) -> tuple[list[int], int]:
    with wave.open(str(path), "rb") as audio:
        frames = audio.getnframes()
        channels = audio.getnchannels()
        data = array.array("h", audio.readframes(frames))
    return list(data), channels


def _premix_window(ws, start: float, end: float, *, approve: str | None = None):
    """Mix a fresh premix on a copy of the project (with ``approve`` approved) and play
    that window from it. Returns the WAV and the trim ``premix.hash`` recorded."""
    import shutil
    import tempfile
    from pathlib import Path

    from podcast_mcp.edits.decisions import approve_edits
    from podcast_mcp.render import rerender_preview
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.document.play import PlayRequest

    root = ws.project.workspace_path()
    copy = Path(tempfile.mkdtemp(dir=root.parent)) / root.name
    shutil.copytree(root, copy)
    fresh = ProjectWorkspace.open(copy)
    if approve is not None:
        assert approve_edits(fresh.project, [approve]) == 1
    rerender_preview(fresh.project, reconcile=False)
    fresh.save()
    wav = (
        PlayService(fresh)
        .play(PlayRequest(source="premix", start_sec=start, end_sec=end), dry_run=True)
        .wav_path
    )
    return wav, read_premix_trim_db(fresh.project)


def _assert_same_audio(preview, approved) -> None:
    got, got_channels = _pcm(preview)
    want, want_channels = _pcm(approved)
    assert got_channels == want_channels
    assert len(got) == len(want)
    assert max(abs(a - b) for a, b in zip(got, want, strict=True)) <= 1


def test_suggested_remove_preview_matches_the_approved_mix(minimal_project) -> None:
    from podcast_mcp.services.document import PlayService

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            replace_gap_sec=0.9,
            crossfade_ms=10,
            review_required=True,
            applied=False,
        ),
    )
    preview = PlayService(ws).play_pending_preview("cut", pad_sec=0.5, dry_run=True).wav_path

    with wave.open(str(preview), "rb") as audio:
        # 0.5 s before + 0.9 s paced pad + 0.5 s after; a butt splice would be 1.0 s.
        assert audio.getnframes() == round(1.9 * 48000)
    approved, trim = _premix_window(ws, 1.5, 3.4, approve="cut")
    assert trim is not None and trim < -1.0
    _assert_same_audio(preview, approved)


def test_suggested_mute_preview_matches_the_approved_mix(minimal_project) -> None:
    from podcast_mcp.services.document import PlayService

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="hush",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=2.0,
            end=2.6,
            review_required=True,
            applied=False,
        ),
    )
    preview = PlayService(ws).play_pending_preview("hush", pad_sec=0.5, dry_run=True).wav_path

    with wave.open(str(preview), "rb") as audio:
        assert audio.getnframes() == round(1.6 * 48000)
    _assert_same_audio(preview, _premix_window(ws, 1.5, 3.1, approve="hush")[0])


def test_suggested_preview_follows_mix_changes_since_the_last_premix(minimal_project) -> None:
    from podcast_mcp.services.document import PlayService

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            replace_gap_sec=0.9,
            crossfade_ms=10,
            review_required=True,
            applied=False,
        ),
    )
    PlayService(ws).play_pending_preview("cut", pad_sec=0.5, dry_run=True)
    trim_before = _premix_window(ws, 1.5, 3.4, approve="cut")[1]
    guest = ws.project.track_by_id("guest")
    assert guest is not None
    guest.fader_db = 6.0
    ws.save()

    preview = PlayService(ws).play_pending_preview("cut", pad_sec=0.5, dry_run=True).wav_path

    approved, trim = _premix_window(ws, 1.5, 3.4, approve="cut")
    assert trim != trim_before
    _assert_same_audio(preview, approved)


def test_a_fader_change_previews_both_sides_at_the_premix_trim_without_mixing_one(
    minimal_project, monkeypatch
) -> None:
    from podcast_mcp.render import rerender_preview
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.document import play as play_module

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            replace_gap_sec=0.9,
            crossfade_ms=10,
            review_required=True,
            applied=False,
        ),
    )
    rerender_preview(ws.project, reconcile=False)
    ws.save()
    trim_before = read_premix_trim_db(ws.project)
    assert PlayService(ws).mix_trim_db() == trim_before
    guest = ws.project.track_by_id("guest")
    assert guest is not None
    guest.fader_db = 6.0
    ws.save()

    def mix_a_premix(*_args, **_kwargs):
        raise AssertionError("the pending preview mixed a premix")

    play = PlayService(ws)
    with monkeypatch.context() as patched:
        patched.setattr(play_module, "rerender_preview", mix_a_premix)
        current = play.play_pending_preview("cut", mode="current", pad_sec=0.5, dry_run=True)
        suggested = play.play_pending_preview("cut", mode="suggested", pad_sec=0.5, dry_run=True)
        trim = play.mix_trim_db()

    fresh_current, premix_trim = _premix_window(ws, 1.5, 3.1)
    fresh_suggested, _ = _premix_window(ws, 1.5, 3.4, approve="cut")
    assert trim == premix_trim
    assert trim != trim_before
    _assert_same_audio(current.wav_path, fresh_current)
    _assert_same_audio(suggested.wav_path, fresh_suggested)


def test_the_mix_trim_is_measured_once_per_mix_and_survives_a_restart(
    minimal_project, monkeypatch
) -> None:
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.document import play as play_module

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            review_required=True,
            applied=False,
        ),
    )
    measured: list[float] = []

    def measure(stems, ceiling):
        measured.append(sum(gain for _path, gain, _hash in stems))
        return -3.5

    monkeypatch.setattr(play_module, "stem_is_fresh", lambda *_args: True)
    monkeypatch.setattr(play_module, "_stem_mix_trim_db", measure)

    assert PlayService(ws).warm_pending_preview()["trim_db"] == -3.5
    restarted = ProjectWorkspace.open(minimal_project)
    assert PlayService(restarted).mix_trim_db() == -3.5
    assert len(measured) == 1

    guest = restarted.project.track_by_id("guest")
    assert guest is not None
    guest.fader_db = 6.0
    restarted.save()
    assert PlayService(ProjectWorkspace.open(minimal_project)).mix_trim_db() == -3.5
    assert measured == [0.0, 6.0]


def test_a_damaged_trim_record_is_measured_again(minimal_project, monkeypatch) -> None:
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.document import play as play_module

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            review_required=True,
            applied=False,
        ),
    )
    monkeypatch.setattr(play_module, "stem_is_fresh", lambda *_args: True)
    monkeypatch.setattr(play_module, "_stem_mix_trim_db", lambda *_args: -2.0)
    PlayService(ws).mix_trim_db()
    (record,) = (ws.project.artifacts_dir() / "play_cache").glob("mix_trim_*.json")
    monkeypatch.setattr(play_module, "_stem_mix_trim_db", lambda *_args: -2.5)
    for damaged in ("{", '{"trim_db": "loud"}', '{"trim_db": 4.0}', "[]"):
        record.write_text(damaged, encoding="utf-8")
        assert PlayService(ws).mix_trim_db() == -2.5
        assert json.loads(record.read_text(encoding="utf-8")) == {"trim_db": -2.5}


def test_a_track_level_profile_is_measured_once_per_file_and_survives_a_restart(
    minimal_project, monkeypatch
) -> None:
    from podcast_mcp.edits import audio_cache
    from podcast_mcp.engines import level_profile
    from podcast_mcp.services.app import ProjectWorkspace

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            review_required=True,
            applied=False,
        ),
    )
    measures: list[int] = []
    real = level_profile.frame_levels_db

    def measure(samples, rate):
        measures.append(rate)
        return real(samples, rate)

    monkeypatch.setattr(level_profile, "frame_levels_db", measure)
    records = ws.project.artifacts_dir() / "level_profiles"
    monkeypatch.setattr(level_profile, "_FILE_PROFILES", {})
    assert audio_cache.track_level_profile(ws.project, "host") is not None
    assert not list(records.glob("*.json"))
    monkeypatch.setattr(level_profile, "_FILE_PROFILES", {})
    measured = audio_cache.track_level_profile(ws.project, "host", record=True)
    assert len(measures) == 2
    assert list(records.glob("*.json"))

    monkeypatch.setattr(level_profile, "_FILE_PROFILES", {})
    reopened = ProjectWorkspace.open(minimal_project)
    assert audio_cache.track_level_profile(reopened.project, "host") == measured
    assert len(measures) == 2

    raw = reopened.project.workspace_path() / "raw" / "host.wav"
    raw.write_bytes(raw.read_bytes() + b"\0\0")
    monkeypatch.setattr(level_profile, "_FILE_PROFILES", {})
    audio_cache.track_level_profile(reopened.project, "host", record=True)
    assert len(measures) == 3


def test_warming_an_edit_leaves_every_mode_cached_for_the_click(minimal_project) -> None:
    from podcast_mcp.services.document import PlayService

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            review_required=True,
            applied=False,
        ),
    )
    play = PlayService(ws)
    assert play.pending_preview_cached_wav("cut", mode="ab") is None
    play.warm_pending_preview("cut")
    for mode in ("current", "suggested", "ab"):
        assert play.pending_preview_cached_wav("cut", mode=mode) is not None
    play.warm_pending_preview("missing")  # an unknown edit warms the mix only


def test_a_transcript_change_does_not_reuse_a_cached_pending_render(minimal_project) -> None:
    from podcast_mcp.models import Transcript, TranscriptWord
    from podcast_mcp.services.document import PlayService

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            review_required=True,
            applied=False,
        ),
    )
    play = PlayService(ws)
    play.warm_pending_preview("cut")
    assert play.pending_preview_cached_wav("cut", mode="suggested") is not None
    ws.project.transcripts = [
        Transcript(
            track_id="host", words=[TranscriptWord(text="so", start=2.0, end=2.2, confidence=0.9)]
        )
    ]
    assert play.pending_preview_cached_wav("cut", mode="suggested") is None


def test_warm_reports_each_side_and_marks_a_render_failure(minimal_project, monkeypatch) -> None:
    from podcast_mcp.services.document import PlayService

    ws = _rendered_project(
        minimal_project,
        EditDecision(
            id="cut",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.6,
            scope="session",
            review_required=True,
            applied=False,
        ),
    )
    play = PlayService(ws)
    assert play.warm_pending_preview("cut")["sides"] == {
        "current": "ready",
        "suggested": "ready",
        "ab": "ready",
    }
    assert play.warm_pending_preview("missing")["sides"] == {
        "current": "unavailable",
        "suggested": "unavailable",
        "ab": "unavailable",
    }

    def broken(self, *_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(PlayService, "play_pending_preview", broken)
    assert set(play.warm_pending_preview("cut")["sides"].values()) == {"failed"}


def test_level_profile_records_keep_only_the_newest(tmp_path, monkeypatch) -> None:
    from podcast_mcp.engines import level_profile

    monkeypatch.setattr(level_profile, "_RECORDS_KEPT", 3)
    records = tmp_path / "level_profiles"
    for index in range(6):
        level_profile._write_record(
            records / f"{index}.json", level_profile.LevelProfile(-60.0, -30.0, -12.0)
        )
    assert len(list(records.glob("*.json"))) == 3
