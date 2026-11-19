from pathlib import Path

import pytest

from podcast_mcp.models.clip_timing import ClipTiming, TimingStep
from podcast_mcp.models.episode import Clip, EpisodeProject, MediaAsset, ReviewMixVersion, Track
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import share


@pytest.mark.parametrize("follow_latest", [False, True], ids=["pinned", "following"])
@pytest.mark.parametrize(
    "stored,clip_start,timing_delta,media_duration,muted,expected",
    [
        pytest.param(3.0, 10.0, 0.0, 100.0, False, 15.0, id="clip-beyond-stored"),
        pytest.param(3.0, 10.0, 0.5, 100.0, False, 15.5, id="timed-clip"),
        pytest.param(3.0, 10.0, 0.0, 100.0, True, 15.0, id="muted-clip"),
        pytest.param(None, 10.0, 0.0, 100.0, False, 15.0, id="missing-stored"),
        pytest.param(0.0, 10.0, 0.0, 100.0, False, 15.0, id="zero-stored"),
        pytest.param(20.0, 10.0, 0.0, 100.0, False, 20.0, id="stored-tail"),
        pytest.param(None, None, 0.0, 12.0, False, 12.0, id="media-fallback"),
        pytest.param(0.0, None, 0.0, 12.0, False, 12.0, id="zero-media-fallback"),
        pytest.param(None, None, 0.0, None, False, 0.0, id="empty-missing-stored"),
        pytest.param(0.0, None, 0.0, None, False, 0.0, id="empty-zero-stored"),
        pytest.param(3.0, None, 0.0, 100.0, False, 3.0, id="positive-stored-no-fallback"),
    ],
)
def test_review_share_duration_matches_the_current_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    follow_latest: bool,
    stored: float | None,
    clip_start: float | None,
    timing_delta: float,
    media_duration: float | None,
    muted: bool,
    expected: float,
) -> None:
    project = EpisodeProject.create("Review duration", str(tmp_path))
    project.timeline.duration_sec = stored
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=media_duration),
            muted=muted,
        )
    ]
    if clip_start is not None:
        timing = (
            ClipTiming(steps=[TimingStep(at=2.0, delta_sec=timing_delta)]) if timing_delta else None
        )
        project.timeline.clips = [
            Clip(
                id="clip",
                track_id="host",
                source_start=0.0,
                source_end=5.0,
                timeline_start=clip_start,
                timing=timing,
            )
        ]
    versions = [
        ReviewMixVersion(
            id=version_id,
            label=label,
            created_at="2026-11-17T00:00:00Z",
            audio_relpath=f"artifacts/review/{version_id}/mix.wav",
            duration_sec=2.0,
            object_store_key="private-object",
            object_store_uploaded_at="2026-11-17T00:00:00Z",
        )
        for version_id, label in [("first", "First"), ("current", "Current")]
    ]
    project.review.versions = versions
    project.review.active_version_id = "current"
    selected = versions[1 if follow_latest else 0]
    ws = ProjectWorkspace(tmp_path / "episode.sharecut", project)
    row = {
        "id": "share-id",
        "review_version_id": selected.id,
        "capabilities": ["play", "view"],
        "follow_latest": follow_latest,
    }
    resolved = []

    def resolve(token: str):
        resolved.append(token)
        return row, ws

    monkeypatch.setattr(share, "open_share_workspace", resolve)
    before = project.model_dump_json()

    view = share.share_project_view("duration-token")

    assert resolved == ["duration-token"]
    assert project.model_dump_json() == before
    assert isinstance(view["timeline_duration_sec"], float)
    assert view == {
        "mode": "review",
        "guest_mode": "view",
        "reads_transcript_words": True,
        "token": "duration-token",
        "author": "share:share-id",
        "meta": {"name": "Review duration"},
        "timeline_duration_sec": expected,
        "review_version": selected.model_dump(
            exclude={"object_store_key", "object_store_uploaded_at"}
        ),
        "link_follows_latest": follow_latest,
        "newer_version": None if follow_latest else {"id": "current", "label": "Current"},
        "comments": [],
        "tracks": [],
        "capabilities": ["play", "view"],
    }
