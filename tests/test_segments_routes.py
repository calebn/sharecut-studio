"""``/api/segments`` over HTTP: adapters on the segment library, host only."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, EpisodeProject, Track, save_project
from podcast_mcp.models.episode import MediaAsset
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from segment_helpers import make_segment_dir

CODE = "X-Sharecut-Error-Code"


@pytest.fixture(autouse=True)
def _config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "config"
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(config))
    return config


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


@pytest.fixture
def project(tmp_workspace: Path, sample_wav: Path) -> Path:
    raw = tmp_workspace / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    episode = EpisodeProject.create("episode", str(tmp_workspace))
    episode.ensure_dirs()
    episode.tracks = [Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav"))]
    episode.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=1.0, timeline_start=2.0),
        Clip(id="c2", track_id="host", source_start=1.0, source_end=2.0, timeline_start=4.0),
    ]
    return save_project(episode)


def _add(tmp_path: Path, **kwargs: object) -> str:
    result = SegmentStore().add(make_segment_dir(tmp_path / "source", **kwargs))  # type: ignore[arg-type]
    return result.id


def test_list_is_empty_without_a_library(client: TestClient) -> None:
    res = client.get("/api/segments")
    assert res.status_code == 200
    assert res.json() == []


def test_list_shows_versions_of_one_id(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path, audio=b"fLaC-one")
    assert _add(tmp_path, audio=b"fLaC-two") == segment_id
    rows = client.get("/api/segments").json()
    assert len(rows) == 1
    assert rows[0]["id"] == segment_id and rows[0]["versions"] == [1, 2]
    assert rows[0]["version"] == 2


def test_list_reports_a_damaged_segment(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    (SegmentStore().path(segment_id) / "clip-01.flac").write_bytes(b"fLaC-onX")
    rows = client.get("/api/segments").json()
    assert rows[0]["id"] == segment_id and rows[0]["damaged"] is True
    assert rows[0]["code"] == "segment_hash_mismatch"


def test_show_and_unknown(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    shown = client.get(f"/api/segments/{segment_id}")
    assert shown.status_code == 200
    assert shown.json()["name"] == "Warm Intro" and shown.json()["versions"] == [1]
    missing = client.get("/api/segments/nope-aaaaaaaa")
    assert missing.status_code == 404
    assert missing.headers[CODE] == "segment_unknown"


def test_audio_bytes(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path, audio=b"fLaC-one")
    res = client.get(f"/api/segments/{segment_id}/audio")
    assert res.status_code == 200
    assert res.content == b"fLaC-one"
    assert res.headers["content-type"] == "audio/flac"
    assert res.headers["cache-control"] == "no-store"


def test_audio_picks_a_version(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path, audio=b"fLaC-one")
    _add(tmp_path, audio=b"fLaC-two")
    assert client.get(f"/api/segments/{segment_id}/audio?version=1").content == b"fLaC-one"
    assert client.get(f"/api/segments/{segment_id}/audio").content == b"fLaC-two"


def test_audio_refusals(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    base = f"/api/segments/{segment_id}/audio"
    out = client.get(f"{base}?clip=1")
    assert out.status_code == 404 and out.headers[CODE] == "segment_unknown"
    version = client.get(f"{base}?version=9")
    assert version.status_code == 404 and version.headers[CODE] == "segment_unknown"
    assert client.get(f"{base}?version=0").status_code == 422
    assert client.get(f"{base}?clip=-1").status_code == 422
    unknown = client.get("/api/segments/nope-aaaaaaaa/audio")
    assert unknown.status_code == 404 and unknown.headers[CODE] == "segment_unknown"


def test_audio_of_changed_media_is_a_400(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    (SegmentStore().path(segment_id) / "clip-01.flac").write_bytes(b"fLaC-onX")
    res = client.get(f"/api/segments/{segment_id}/audio")
    assert res.status_code == 400 and res.headers[CODE] == "segment_hash_mismatch"


def test_save_by_clips_then_unchanged(client: TestClient, project: Path) -> None:
    body = {"path": str(project), "name": "Warm Intro", "clip_ids": ["c1", "c2"]}
    first = client.post("/api/segments", json=body)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "added" and first.json()["version"] == 1
    again = client.post("/api/segments", json=body)
    assert again.status_code == 200 and again.json()["status"] == "unchanged"
    rows = client.get("/api/segments").json()
    assert len(rows) == 1 and rows[0]["id"] == first.json()["id"]


def test_save_by_range_with_kind(client: TestClient, project: Path) -> None:
    res = client.post(
        "/api/segments",
        json={"path": str(project), "name": "Ad", "time_range": "0:00-0:05", "kind": "sponsor"},
    )
    assert res.status_code == 200, res.text
    assert client.get(f"/api/segments/{res.json()['id']}").json()["kind"] == "sponsor"


@pytest.mark.parametrize(
    ("extra", "code"),
    [
        ({}, "segment_selection_invalid"),
        ({"clip_ids": ["c1"], "kind": "jingle"}, "segment_kind_invalid"),
        ({"time_range": "banana"}, "segment_range_invalid"),
        ({"clip_ids": ["nope"]}, "segment_clip_unknown"),
        ({"clip_ids": ["c1"], "name": "   "}, "segment_name_invalid"),
    ],
)
def test_save_errors_carry_the_service_code(
    client: TestClient, project: Path, extra: dict[str, object], code: str
) -> None:
    body: dict[str, object] = {"path": str(project), "name": "Warm Intro", **extra}
    res = client.post("/api/segments", json=body)
    assert res.status_code == 400, res.text
    assert res.headers[CODE] == code
    assert client.get("/api/segments").json() == []


def test_save_of_a_missing_project_is_404(client: TestClient, tmp_path: Path) -> None:
    res = client.post(
        "/api/segments",
        json={"path": str(tmp_path / "nope.sharecut"), "name": "A", "clip_ids": ["c1"]},
    )
    assert res.status_code == 404


def test_remove_then_remove_again(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    gone = client.delete(f"/api/segments/{segment_id}")
    assert gone.status_code == 200 and gone.json() == {"removed": segment_id}
    assert client.get("/api/segments").json() == []
    again = client.delete(f"/api/segments/{segment_id}")
    assert again.status_code == 404 and again.headers[CODE] == "segment_unknown"


def test_busy_library_is_409(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.segments import store as store_module
    from podcast_mcp.util.coded_error import CodedValueError

    segment_id = _add(tmp_path)

    def busy(self: object, _id: str) -> None:
        raise CodedValueError("busy", code="segment_busy")

    monkeypatch.setattr(store_module.SegmentStore, "remove", busy)
    res = client.delete(f"/api/segments/{segment_id}")
    assert res.status_code == 409 and res.headers[CODE] == "segment_busy"


def test_a_foreign_origin_is_refused(client: TestClient, tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    evil = {"Origin": "https://evil.example"}
    assert client.get("/api/segments", headers=evil).status_code == 403
    assert client.get(f"/api/segments/{segment_id}/audio", headers=evil).status_code == 403
    assert client.delete(f"/api/segments/{segment_id}", headers=evil).status_code == 403
    assert SegmentStore().versions(segment_id) == [1]


def test_a_relayed_request_is_refused(tmp_path: Path) -> None:
    segment_id = _add(tmp_path)
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )
    assert relayed.get("/api/segments").status_code in (401, 403)
    assert relayed.get(f"/api/segments/{segment_id}").status_code in (401, 403)
    assert relayed.delete(f"/api/segments/{segment_id}").status_code in (401, 403)
    assert relayed.post("/api/segments", json={"path": "p", "name": "n"}).status_code in (401, 403)
    assert SegmentStore().versions(segment_id) == [1]


def test_write_failure_is_a_500(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.segments import store as store_module
    from podcast_mcp.util.coded_error import CodedValueError

    segment_id = _add(tmp_path)

    def failing(self: object, _id: str) -> None:
        raise CodedValueError("disk", code="segment_write_failed")

    monkeypatch.setattr(store_module.SegmentStore, "remove", failing)
    res = client.delete(f"/api/segments/{segment_id}")
    assert res.status_code == 500 and res.headers[CODE] == "segment_write_failed"


@pytest.mark.parametrize(
    "segment_id",
    ["..%2F..%2Fsecret", "%2E%2E", "..%5Csecret", "%2Fetc%2Fpasswd", "a%00b"],
)
def test_traversal_ids_are_404_and_serve_nothing(
    client: TestClient, tmp_path: Path, segment_id: str
) -> None:
    (tmp_path / "config" / "secret.txt").parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / "config" / "secret.txt").write_bytes(b"top-secret")
    _add(tmp_path)
    for suffix in ("", "/audio"):
        res = client.get(f"/api/segments/{segment_id}{suffix}")
        assert res.status_code in (404, 400), res.status_code
        assert b"top-secret" not in res.content
    assert client.delete(f"/api/segments/{segment_id}").status_code in (404, 400)
    assert (tmp_path / "config" / "secret.txt").exists()
