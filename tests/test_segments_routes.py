"""The host-only HTTP routes over the segment library (#1777)."""

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
    config = tmp_path / "route-config"
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


def _stored(tmp_path: Path, **kwargs: object) -> str:
    result = SegmentStore().add(make_segment_dir(tmp_path / "src", **kwargs))
    return result.id


def test_an_empty_library_lists_nothing(client: TestClient) -> None:
    response = client.get("/api/segments")
    assert response.status_code == 200 and response.json() == []


def test_the_library_lists_each_segment_with_its_versions(
    client: TestClient, tmp_path: Path
) -> None:
    segment_id = _stored(tmp_path)
    _stored(tmp_path, audio=b"fLaC-two")

    rows = client.get("/api/segments").json()

    assert [(row["id"], row["versions"]) for row in rows] == [(segment_id, [1, 2])]
    assert rows[0]["version"] == 2


def test_a_damaged_segment_is_listed_not_hidden(client: TestClient, tmp_path: Path) -> None:
    segment_id = _stored(tmp_path)
    (SegmentStore().path(segment_id) / "clip-01.flac").unlink()

    rows = client.get("/api/segments").json()

    assert rows[0]["id"] == segment_id and rows[0]["damaged"] is True and rows[0]["code"]


def test_show_returns_one_segment_and_an_unknown_id_is_404(
    client: TestClient, tmp_path: Path
) -> None:
    segment_id = _stored(tmp_path)

    assert client.get(f"/api/segments/{segment_id}").json()["name"] == "Warm Intro"
    missing = client.get("/api/segments/nope-00000000")
    assert missing.status_code == 404 and missing.headers[CODE] == "segment_unknown"


def test_audio_serves_the_clip_and_refuses_a_missing_clip_or_version(
    client: TestClient, tmp_path: Path
) -> None:
    segment_id = _stored(tmp_path)

    audio = client.get(f"/api/segments/{segment_id}/audio")
    assert audio.status_code == 200
    assert audio.content == b"fLaC-one" and audio.headers["content-type"] == "audio/flac"
    assert audio.headers["cache-control"] == "no-store"
    assert client.get(f"/api/segments/{segment_id}/audio?clip=1").status_code == 404
    assert client.get(f"/api/segments/{segment_id}/audio?version=2").status_code == 404
    assert client.get(f"/api/segments/{segment_id}/audio?version=0").status_code == 422


def test_audio_of_changed_media_is_refused_by_its_hash(client: TestClient, tmp_path: Path) -> None:
    segment_id = _stored(tmp_path)
    (SegmentStore().path(segment_id) / "clip-01.flac").write_bytes(b"changed!")

    response = client.get(f"/api/segments/{segment_id}/audio")

    assert response.status_code == 400 and response.headers[CODE] == "segment_hash_mismatch"


def test_save_copies_clips_into_the_library_and_reports_the_status(
    client: TestClient, project: Path
) -> None:
    first = client.post(
        "/api/segments", json={"path": str(project), "name": "Warm Intro", "clip_ids": ["c1", "c2"]}
    )
    again = client.post(
        "/api/segments", json={"path": str(project), "name": "Warm Intro", "clip_ids": ["c1", "c2"]}
    )

    assert first.status_code == 200 and first.json()["status"] == "added"
    assert again.json()["status"] == "unchanged"
    assert client.get("/api/segments").json()[0]["id"] == first.json()["id"]


def test_save_by_range_takes_a_kind(client: TestClient, project: Path) -> None:
    response = client.post(
        "/api/segments",
        json={"path": str(project), "name": "Bumper", "time_range": "0:00-0:05", "kind": "sting"},
    )

    assert response.status_code == 200
    assert client.get(f"/api/segments/{response.json()['id']}").json()["kind"] == "sting"


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"name": "x"}, "segment_selection_invalid"),
        ({"name": "x", "clip_ids": ["c1"], "kind": "podcast"}, "segment_kind_invalid"),
        ({"name": "x", "time_range": "soon"}, "segment_range_invalid"),
        ({"name": "!!!", "clip_ids": ["c1"]}, "segment_name_invalid"),
    ],
)
def test_save_refuses_a_bad_request_with_the_service_code(
    client: TestClient, project: Path, body: dict[str, object], code: str
) -> None:
    response = client.post("/api/segments", json={"path": str(project), **body})

    assert response.status_code == 400 and response.headers[CODE] == code


def test_remove_deletes_every_version_and_a_second_remove_is_404(
    client: TestClient, tmp_path: Path
) -> None:
    segment_id = _stored(tmp_path)

    assert client.delete(f"/api/segments/{segment_id}").json() == {"removed": segment_id}
    assert client.get("/api/segments").json() == []
    assert client.delete(f"/api/segments/{segment_id}").status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [("get", "/api/segments"), ("get", "/api/segments/x-00000000"), ("delete", "/api/segments/x")],
)
def test_a_relayed_or_foreign_origin_request_never_reaches_the_library(
    tmp_path: Path, method: str, path: str
) -> None:
    _stored(tmp_path)
    relayed = TestClient(create_app(), client=("127.0.0.1", 50000))

    foreign = getattr(relayed, method)(path, headers={"Origin": "https://evil.example"})
    via_relay = getattr(relayed, method)(path, headers={RELAYED_REQUEST_HEADER: "1"})

    assert foreign.status_code == 403
    assert via_relay.status_code in (401, 403)
    assert len(SegmentStore().list()) == 1
