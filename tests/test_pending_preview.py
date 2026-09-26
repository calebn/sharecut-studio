from __future__ import annotations

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
