from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import save_project
from podcast_mcp.services import EditService, ProjectWorkspace, ReviewService
from podcast_mcp.services.play import WAVEFORM_WINDOW_MAX_SEC, PlayService
from podcast_mcp.services.share import ShareService, share_daw_peaks


def test_waveform_snap_window_returns_ticks(minimal_project, sample_wav):
    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_peaks_jobs()
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

    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_peaks_jobs()
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


def test_extract_waveform_window_caps_span(minimal_project, sample_wav):
    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_peaks_jobs()
    with patch("podcast_mcp.services.play.FFmpegEngine.extract_segment") as ext:

        def _write(src, output_path, start_sec, end_sec):
            Path(output_path).write_bytes(b"RIFF")
            return output_path

        ext.side_effect = _write
        PlayService(ws).extract_waveform_window(
            kind="raw",
            track_id="host",
            start_sec=0.0,
            end_sec=WAVEFORM_WINDOW_MAX_SEC + 20,
        )
        start_sec = ext.call_args.args[2]
        end_sec = ext.call_args.args[3]
        assert end_sec - start_sec <= WAVEFORM_WINDOW_MAX_SEC + 1e-9
    with pytest.raises(ValueError, match="invalid track_id"):
        PlayService(ws).extract_waveform_window(
            kind="raw",
            track_id="../evil",
            start_sec=0.0,
            end_sec=0.2,
        )
    with pytest.raises(ValueError, match="unknown track"):
        PlayService(ws).extract_waveform_window(
            kind="raw",
            track_id="missing",
            start_sec=0.0,
            end_sec=0.2,
        )
    with pytest.raises(ValueError, match="end must be after start"):
        PlayService(ws).extract_waveform_window(
            kind="raw",
            track_id="host",
            start_sec=1.0,
            end_sec=0.2,
        )


def test_extract_waveform_window_unlinks_tmp_on_failure(minimal_project, sample_wav):
    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_peaks_jobs()
    with patch(
        "podcast_mcp.services.play.FFmpegEngine.extract_segment",
        side_effect=RuntimeError("ffmpeg"),
    ):
        with pytest.raises(RuntimeError, match="ffmpeg"):
            PlayService(ws).extract_waveform_window(
                kind="raw",
                track_id="host",
                start_sec=0.0,
                end_sec=0.2,
            )
    cache = Path(ws.project.workspace_dir) / "artifacts" / "play_cache"
    leftovers = list(cache.glob(".wf_raw_host*")) if cache.is_dir() else []
    assert leftovers == []


def test_api_audio_etag_and_window(minimal_project, sample_wav):
    pytest.importorskip("fastapi")
    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("guest", str(sample_wav), speaker="G")
    wait_peaks_jobs()
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
    win = client.get(
        "/api/audio",
        params={
            "path": str(minimal_project),
            "kind": "raw",
            "track_id": "guest",
            "start_sec": 0.0,
            "end_sec": 0.2,
        },
    )
    assert win.status_code == 200
    assert len(win.content) < len(res.content) or len(win.content) > 44


def test_api_waveform_snap_route(minimal_project, sample_wav):
    pytest.importorskip("fastapi")
    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_peaks_jobs()
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


def test_guest_peaks_are_overview_not_coarsened(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    pytest.importorskip("fastapi")
    from podcast_mcp.engines.peaks import wait_peaks_jobs
    from podcast_mcp.services.episode import EpisodeService

    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_workspace / "shares_index.json"))
    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host")
    wait_peaks_jobs()
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
    payload = share_daw_peaks(view_share["token"], "host")
    assert payload.get("encoding") == "uint8"
    assert "guest_downsampled" not in payload
    assert "source" not in payload
    host = TestClient(create_app()).get(
        "/api/peaks/host",
        params={"path": str(minimal_project)},
    )
    guest = TestClient(create_app()).get(
        f"/api/review/{view_share['token']}/daw/peaks/host",
    )
    assert host.status_code == 200
    assert guest.status_code == 200
    assert guest.json().get("bins_per_sec") == host.json().get("bins_per_sec")
    assert len(guest.json().get("peaks", [])) == len(host.json().get("peaks", []))
    assert "source" not in guest.json()
    assert "/" not in str(guest.json().get("source", ""))

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
