from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.waveform_pyramid import (
    pyramid_path,
    read_bins,
    read_meta,
    read_pcm_minmax,
    wait_pyramid_jobs,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.services import waveform as svc
from waveform_helpers import reset_waveform_caches, waveform_project

IMMUTABLE = "private, max-age=31536000, immutable"


@pytest.fixture(autouse=True)
def _fresh_caches():
    reset_waveform_caches()
    yield
    wait_pyramid_jobs()


def _ready_key(client: TestClient, project_path) -> str:
    params = {"path": str(project_path)}
    client.get("/api/waveform/status", params=params)
    wait_pyramid_jobs()
    body = client.get("/api/waveform/status", params=params).json()
    return body["media"]["track:host"]["key"]


def test_status_route_is_no_store(tmp_path):
    project_path = waveform_project(tmp_path)
    client = TestClient(create_app())
    res = client.get("/api/waveform/status", params={"path": str(project_path)})
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    assert res.json()["media"]["track:host"] == {"status": "generating"}
    stem = client.get("/api/waveform/status", params={"path": str(project_path), "kind": "stem"})
    assert stem.json() == {"format_version": 1, "media": {}}
    bad = client.get("/api/waveform/status", params={"path": str(project_path), "kind": "x"})
    assert bad.status_code == 400
    assert bad.headers["cache-control"] == "no-store"


def test_tiles_route_serves_immutable_bins(tmp_path):
    project_path = waveform_project(tmp_path)
    client = TestClient(create_app())
    key = _ready_key(client, project_path)
    res = client.get(
        f"/api/waveform/tiles/{key}",
        params={"path": str(project_path), "ref": "track:host", "level": 0, "start": 0},
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/octet-stream"
    assert res.headers["cache-control"] == IMMUTABLE
    assert res.headers["etag"] == f'"{key}-0-0-1"'
    path = pyramid_path(project_path.parent / "artifacts" / "peaks", "track-host", key)
    assert res.content == read_bins(path, read_meta(path), 0, 0, 4096)


@pytest.mark.parametrize(
    ("key_override", "params", "status"),
    [
        ("NOTAKEY", {"ref": "track:host", "level": 0, "start": 0}, 400),
        (None, {"ref": "clip:host", "level": 0, "start": 0}, 400),
        (None, {"ref": "track:host", "level": 3, "start": 0}, 400),
        (None, {"ref": "track:host", "level": 0, "start": 0, "count": 17}, 400),
        ("0" * 20, {"ref": "track:host", "level": 0, "start": 0}, 404),
        (None, {"ref": "track:nope", "level": 0, "start": 0}, 404),
    ],
)
def test_tiles_route_errors_are_no_store(tmp_path, key_override, params, status):
    project_path = waveform_project(tmp_path)
    client = TestClient(create_app())
    key = key_override or _ready_key(client, project_path)
    res = client.get(f"/api/waveform/tiles/{key}", params={"path": str(project_path), **params})
    assert res.status_code == status
    assert res.headers["cache-control"] == "no-store"


def test_pcm_route_blocks_and_stale_key(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "pcm_block_frames", lambda: 512)
    project_path = waveform_project(tmp_path)
    client = TestClient(create_app())
    key = _ready_key(client, project_path)
    base = {"path": str(project_path), "ref": "track:host"}
    res = client.get(f"/api/waveform/pcm/{key}", params={**base, "block": 1})
    assert res.status_code == 200
    assert res.headers["cache-control"] == IMMUTABLE
    assert res.headers["etag"] == f'"{key}-pcm-1"'
    pairs = np.frombuffer(res.content, "<i2").reshape(-1, 2)
    np.testing.assert_array_equal(
        pairs, read_pcm_minmax(project_path.parent / "raw" / "host.wav", 512, 512)
    )
    stale = client.get(f"/api/waveform/pcm/{'0' * 20}", params={**base, "block": 0})
    assert stale.status_code == 409
    assert stale.headers["cache-control"] == "no-store"
    out_of_range = client.get(f"/api/waveform/pcm/{key}", params={**base, "block": 999})
    assert out_of_range.status_code == 400


def test_waveform_routes_respect_servedwaveform_project(tmp_path):
    project_path = waveform_project(tmp_path)
    other = waveform_project(tmp_path / "other")
    client = TestClient(create_app(served_project=other))
    res = client.get("/api/waveform/status", params={"path": str(project_path)})
    assert res.status_code == 403
    assert res.headers["cache-control"] == "no-store"
    missing = client.get("/api/waveform/status", params={"path": str(tmp_path / "nope.json")})
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"
