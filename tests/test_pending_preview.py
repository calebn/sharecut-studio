from __future__ import annotations

import array
import math
import wave

import pytest

from podcast_mcp.edits.pending_preview import (
    SKIP_REASON_MUTE,
    SKIP_REASON_SESSION_ONLY,
    SKIP_REASON_SPLIT,
    SKIP_REASON_TOO_SHORT,
    SKIP_REASON_TRACK,
    SKIP_REASON_UNMAPPED,
    _skip_reason,
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


@pytest.mark.parametrize(
    ("type_val", "scope", "mappable", "duration", "expected"),
    [
        ("remove", "session", True, 1.0, None),
        ("split", "session", False, 0.0, SKIP_REASON_SPLIT),
        ("mute", "track", True, 1.0, SKIP_REASON_MUTE),
        ("remove", "track", True, 1.0, SKIP_REASON_TRACK),
        ("remove", "session", False, 1.0, SKIP_REASON_UNMAPPED),
        ("remove", "session", True, 0.02, SKIP_REASON_TOO_SHORT),
        ("future", "session", True, 1.0, SKIP_REASON_SESSION_ONLY),
    ],
)
def test_skip_reason_preserves_preview_priority(type_val, scope, mappable, duration, expected):
    assert _skip_reason(type_val, scope, mappable, duration) == expected


def test_session_remove_can_skip() -> None:
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
    assert window.can_skip is True
    assert window.skip_reason is None
    assert window.timeline_start == pytest.approx(2.0)
    assert window.timeline_end == pytest.approx(4.0)
    assert window.play_start == pytest.approx(1.5)
    assert window.play_end == pytest.approx(4.5)


def test_split_and_track_punch_cannot_skip() -> None:
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
    split = resolve_pending_preview(proj, "split1")
    assert split.can_skip is False
    assert split.skip_reason is not None
    assert "split" in split.skip_reason.lower()
    punch = resolve_pending_preview(proj, "punch1")
    assert punch.can_skip is False
    assert punch.skip_reason is not None
    assert "timeline length" in punch.skip_reason.lower()


def test_missing_pending_edit_raises() -> None:
    with pytest.raises(KeyError, match="pending edit not found"):
        resolve_pending_preview(_project(), "missing")


def test_unmappable_and_tiny_remove_cannot_skip() -> None:
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
    away = resolve_pending_preview(proj, "away")
    assert away.can_skip is False
    assert away.skip_reason is not None
    assert "not on the current timeline" in away.skip_reason
    tiny = resolve_pending_preview(proj, "tiny")
    assert tiny.can_skip is False
    assert tiny.skip_reason is not None
    assert "too short" in tiny.skip_reason.lower()


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


def _approved_premix_window(ws, edit_id: str, start: float, end: float):
    """Approve ``edit_id`` on a copy of the project and play that window from its premix."""
    import shutil

    from podcast_mcp.edits.decisions import approve_edits
    from podcast_mcp.render import rerender_preview
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.document.play import PlayRequest

    root = ws.project.workspace_path()
    copy = root.parent / f"{root.name}-approved"
    shutil.copytree(root, copy)
    approved = ProjectWorkspace.open(copy)
    assert approve_edits(approved.project, [edit_id]) == 1
    rerender_preview(approved.project, reconcile=False)
    approved.save()
    return (
        PlayService(approved)
        .play(PlayRequest(source="premix", start_sec=start, end_sec=end), dry_run=True)
        .wav_path
    )


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

    assert read_premix_trim_db(ws.project) < -1.0
    with wave.open(str(preview), "rb") as audio:
        # 0.5 s before + 0.9 s paced pad + 0.5 s after; a butt splice would be 1.0 s.
        assert audio.getnframes() == round(1.9 * 48000)
    _assert_same_audio(preview, _approved_premix_window(ws, "cut", 1.5, 3.4))


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
    _assert_same_audio(preview, _approved_premix_window(ws, "hush", 1.5, 3.1))


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
    trim_before = read_premix_trim_db(ws.project)
    guest = ws.project.track_by_id("guest")
    assert guest is not None
    guest.fader_db = 6.0
    ws.save()

    preview = PlayService(ws).play_pending_preview("cut", pad_sec=0.5, dry_run=True).wav_path

    assert read_premix_trim_db(ws.project) != trim_before
    _assert_same_audio(preview, _approved_premix_window(ws, "cut", 1.5, 3.4))
