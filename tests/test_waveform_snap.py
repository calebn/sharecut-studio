from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.waveform_pyramid import wait_pyramid_jobs
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import save_project
from podcast_mcp.services import EditService, ProjectWorkspace, ReviewService
from podcast_mcp.services.share import ShareService


def test_waveform_snap_window_returns_ticks(minimal_project, sample_wav):
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_pyramid_jobs()
    with patch.object(
        EditService,
        "preview_inaudible_cut",
        return_value={"start": 1.01, "end": 1.2, "mode": "word"},
    ):
        out = EditService(ws).waveform_snap_window(
            track_id="host",
            start=1.0,
            end=1.3,
            timeline=False,
        )
    assert out["ticks"]
    assert out["end"] - out["start"] <= 2.0 + 1e-9
    focused = EditService(ws).waveform_snap_window(
        track_id="host",
        start=0.0,
        end=10.0,
        timeline=False,
        focus=8.0,
    )
    assert focused["start"] == pytest.approx(7.0)
    assert focused["end"] == pytest.approx(9.0)


def test_waveform_snap_window_swaps_tiny_span_and_skips_errors(minimal_project, sample_wav):
    from types import SimpleNamespace

    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_pyramid_jobs()
    swapped = EditService(ws).waveform_snap_window(
        track_id="host",
        start=1.3,
        end=1.0,
        timeline=False,
    )
    assert swapped["start"] == pytest.approx(1.0)
    assert swapped["end"] == pytest.approx(1.3)
    tiny = EditService(ws).waveform_snap_window(
        track_id="host",
        start=1.0,
        end=1.01,
        timeline=False,
    )
    assert tiny["start"] == pytest.approx(1.0)
    assert tiny["end"] == pytest.approx(1.05)
    with patch.object(EditService, "preview_inaudible_cut", side_effect=RuntimeError("nope")):
        skipped = EditService(ws).waveform_snap_window(
            track_id="host",
            start=1.0,
            end=1.3,
            timeline=False,
        )
    assert skipped["preview"] is None
    island = SimpleNamespace(to_dict=lambda: {"midpoint": 1.1, "start": 1.0, "end": 1.2})
    with (
        patch.object(
            EditService,
            "preview_inaudible_cut",
            return_value={"start": 1.01, "end": 1.2, "mode": "word"},
        ),
        patch("podcast_mcp.services.edit.timeline_rms_hops", return_value=[]),
        patch(
            "podcast_mcp.services.edit.silence_islands_from_hops",
            return_value=[island],
        ),
    ):
        timed = EditService(ws).waveform_snap_window(
            track_id="host",
            start=1.0,
            end=1.3,
            timeline=True,
        )
    assert timed["islands"] == [{"midpoint": 1.1, "start": 1.0, "end": 1.2}]
    assert 1.1 in timed["ticks"]
    with patch(
        "podcast_mcp.services.edit.timeline_rms_hops",
        side_effect=RuntimeError("hops"),
    ):
        hop_fail = EditService(ws).waveform_snap_window(
            track_id="host",
            start=1.0,
            end=1.3,
            timeline=True,
        )
    assert hop_fail["islands"] == []


def test_api_audio_etag(minimal_project, sample_wav):
    pytest.importorskip("fastapi")
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("guest", str(sample_wav), speaker="G")
    wait_pyramid_jobs()
    client = TestClient(create_app())
    res = client.get(
        "/api/audio",
        params={
            "path": str(minimal_project),
            "kind": "raw",
            "track_id": "guest",
        },
    )
    assert res.status_code == 200
    assert "etag" in {k.lower() for k in res.headers}
    assert "must-revalidate" in res.headers.get("cache-control", "").lower()
    etag = res.headers.get("etag")
    assert etag
    not_mod = client.get(
        "/api/audio",
        params={
            "path": str(minimal_project),
            "kind": "raw",
            "track_id": "guest",
        },
        headers={"If-None-Match": etag},
    )
    assert not_mod.status_code == 304
    stale = client.get(
        "/api/audio",
        params={
            "path": str(minimal_project),
            "kind": "raw",
            "track_id": "guest",
        },
        headers={"If-None-Match": '"nope"'},
    )
    assert stale.status_code == 200


def test_api_waveform_snap_route(minimal_project, sample_wav):
    pytest.importorskip("fastapi")
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_pyramid_jobs()
    client = TestClient(create_app())
    with patch(
        "podcast_mcp.services.edit.EditService.preview_inaudible_cut",
        return_value={"start": 0.1, "end": 0.2, "mode": "x"},
    ):
        res = client.get(
            "/api/waveform-snap",
            params={
                "path": str(minimal_project),
                "track_id": "host",
                "start": 0.0,
                "end": 0.4,
            },
        )
    assert res.status_code == 200
    body = res.json()
    assert "ticks" in body


def test_guest_waveform_snap_needs_suggest(minimal_project, sample_wav):
    pytest.importorskip("fastapi")
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_pyramid_jobs()
    art = Path(ws.project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(Path(sample_wav).read_bytes())
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="Wave")
    view_share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    snap = TestClient(create_app()).get(
        f"/api/review/{view_share['token']}/daw/waveform-snap",
        params={"track_id": "host", "start": 0.0, "end": 0.4},
    )
    assert snap.status_code == 403

    suggest = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "suggest"],
    )
    with patch(
        "podcast_mcp.services.edit.EditService.preview_inaudible_cut",
        return_value={"start": 0.1, "end": 0.2, "mode": "x"},
    ):
        ok = TestClient(create_app()).get(
            f"/api/review/{suggest['token']}/daw/waveform-snap",
            params={"track_id": "host", "start": 0.0, "end": 0.4},
        )
    assert ok.status_code == 200
    assert "ticks" in ok.json()
