"""``/api/segments/{id}/export`` and ``/api/segments/import/*``: one file out, one file in, host only."""

from __future__ import annotations

import os
import stat
import tempfile
import time
import zipfile
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from podcast_mcp.gui.routes import segment_import
from podcast_mcp.gui.server import create_app
from podcast_mcp.segments import bundle, import_staging
from podcast_mcp.segments.bundle import MANIFEST, export_segments
from podcast_mcp.segments.import_staging import MAX_STAGED, STAGED_TTL_SEC
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.util.body_limits import SEGMENT_IMPORT_PREVIEW_PATH
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from segment_helpers import make_segment_dir, rewrite_zip

CODE = "X-Sharecut-Error-Code"
PREVIEW = SEGMENT_IMPORT_PREVIEW_PATH
STREAM = {"Content-Type": "application/octet-stream"}


@pytest.fixture(autouse=True)
def _config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config = tmp_path / "config"
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(config))
    return config


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=("127.0.0.1", 50000))


@pytest.fixture
def staging_dir(_config_dir: Path) -> Path:
    return _config_dir / "segments" / ".staging"


def _file(tmp_path: Path, *, name: str = "Warm Intro", audio: bytes = b"fLaC-one") -> bytes:
    """A real ``.sharecutseg`` made from a throwaway library."""
    library = SegmentStore(tmp_path / f"lib-{name}-{len(audio)}-{audio[-3:].decode()}")
    library.add(make_segment_dir(tmp_path / "in", name=name, audio=audio))
    out = export_segments(library, [library.list()[0].id], tmp_path / f"{name}-{len(audio)}.zip")
    return out.read_bytes()


def _preview(client: TestClient, data: bytes) -> dict[str, object]:
    res = client.post(PREVIEW, content=data, headers=STREAM)
    assert res.status_code == 200, res.text
    body: dict[str, object] = res.json()
    return body


def _staged(staging_dir: Path) -> list[str]:
    return sorted(p.name for p in staging_dir.iterdir()) if staging_dir.is_dir() else []


def _expect(client: TestClient, data: bytes, status: int, code: str, staging_dir: Path) -> None:
    res = client.post(PREVIEW, content=data, headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (status, code), res.text
    assert _staged(staging_dir) == []
    assert SegmentStore().list() == []


def test_export_is_the_file_the_command_line_writes(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    segment_id = SegmentStore().add(make_segment_dir(tmp_path / "s")).id
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))

    res = client.get(f"/api/segments/{segment_id}/export")

    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["content-disposition"] == 'attachment; filename="warm-intro.sharecutseg"'
    cli = export_segments(SegmentStore(), [segment_id], tmp_path / "cli.sharecutseg")
    served = tmp_path / "served.sharecutseg"
    served.write_bytes(res.content)
    with zipfile.ZipFile(served) as got, zipfile.ZipFile(cli) as want:
        assert sorted(got.namelist()) == sorted(want.namelist())
        assert all(got.read(name) == want.read(name) for name in want.namelist())
    assert list(scratch.iterdir()) == []


def test_export_of_an_unknown_segment_is_a_404(client: TestClient, tmp_path: Path) -> None:
    res = client.get("/api/segments/nothing-00000000/export")
    assert (res.status_code, res.headers[CODE]) == (404, "segment_unknown")


def test_export_of_a_segment_too_big_to_import_is_refused(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    segment_id = SegmentStore().add(make_segment_dir(tmp_path / "s")).id
    monkeypatch.setattr(bundle, "MAX_BUNDLE_BYTES", 10)
    res = client.get(f"/api/segments/{segment_id}/export")
    assert (res.status_code, res.headers[CODE]) == (422, "segment_bundle_too_large")


def test_a_hostile_name_never_reaches_the_file_name(client: TestClient, tmp_path: Path) -> None:
    segment_id = (
        SegmentStore().add(make_segment_dir(tmp_path / "s", name='Ad "break"; \r\nX: 1/../é')).id
    )
    disposition = client.get(f"/api/segments/{segment_id}/export").headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    assert "\n" not in disposition and "/" not in disposition and ".." not in disposition


def test_preview_describes_the_file_and_adds_nothing(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    body = _preview(client, _file(tmp_path))

    assert {k: v for k, v in body.items() if k != "token"} == {
        "name": "Warm Intro",
        "kind": "intro",
        "duration_sec": 2.0,
        "clip_count": 1,
        "outcome": "added",
        "version": 1,
        "existing_id": None,
    }
    assert SegmentStore().list() == []
    assert _staged(staging_dir) == [f"{body['token']}.sharecutseg"]
    assert stat.S_IMODE(staging_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE((staging_dir / _staged(staging_dir)[0]).stat().st_mode) == 0o600


def test_commit_adds_the_segment_and_clears_staging(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]

    res = client.post("/api/segments/import", json={"token": token})

    assert res.status_code == 200
    assert (res.json()["status"], res.json()["version"]) == ("added", 1)
    assert [s.name for s in SegmentStore().list()] == ["Warm Intro"]
    assert _staged(staging_dir) == []


def test_the_same_file_again_is_unchanged_and_new_audio_is_a_new_version(
    client: TestClient, tmp_path: Path
) -> None:
    data = _file(tmp_path)
    first = client.post("/api/segments/import", json={"token": _preview(client, data)["token"]})

    again = _preview(client, data)
    assert (again["outcome"], again["existing_id"]) == ("unchanged", first.json()["id"])
    assert (
        client.post("/api/segments/import", json={"token": again["token"]}).json()["status"]
        == "unchanged"
    )

    changed = _preview(client, _file(tmp_path, audio=b"fLaC-two"))
    assert (changed["outcome"], changed["version"]) == ("new_version", 2)
    done = client.post("/api/segments/import", json={"token": changed["token"]}).json()
    assert (done["status"], done["version"]) == ("new_version", 2)
    assert SegmentStore().versions(first.json()["id"]) == [1, 2]


def test_a_token_commits_once(client: TestClient, tmp_path: Path) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    assert client.post("/api/segments/import", json={"token": token}).status_code == 200
    again = client.post("/api/segments/import", json={"token": token})
    assert (again.status_code, again.headers[CODE]) == (404, "segment_import_unknown")


def test_a_busy_library_keeps_the_staged_file_for_a_retry(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add

    def busy(self: SegmentStore, folder: Path) -> object:
        raise CodedValueError("busy", code="segment_busy")

    monkeypatch.setattr(SegmentStore, "add", busy)
    res = client.post("/api/segments/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (409, "segment_busy")
    assert _staged(staging_dir) == [f"{token}.sharecutseg"]

    monkeypatch.setattr(SegmentStore, "add", real)
    assert client.post("/api/segments/import", json={"token": token}).status_code == 200


def test_cancel_removes_the_file_and_its_clip_copy(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    assert client.get(f"/api/segments/import/{token}/audio?clip=0").status_code == 200
    assert len(_staged(staging_dir)) == 2

    assert client.delete(f"/api/segments/import/{token}").status_code == 200
    assert _staged(staging_dir) == []
    assert client.delete(f"/api/segments/import/{token}").status_code == 200
    assert client.get(f"/api/segments/import/{token}/audio").status_code == 404


def test_a_staged_clip_plays_and_a_missing_one_is_a_404(client: TestClient, tmp_path: Path) -> None:
    token = _preview(client, _file(tmp_path))["token"]

    played = client.get(f"/api/segments/import/{token}/audio?clip=0")
    assert (played.status_code, played.content) == (200, b"fLaC-one")
    assert played.headers["content-type"] == "audio/flac"
    assert (
        client.get(
            f"/api/segments/import/{token}/audio?clip=0", headers={"Range": "bytes=0-3"}
        ).status_code
        == 206
    )
    missing = client.get(f"/api/segments/import/{token}/audio?clip=3")
    assert (missing.status_code, missing.headers[CODE]) == (404, "segment_unknown")


@pytest.mark.parametrize(
    "token", ["0" * 31, "0" * 33, "A" * 32, "g" * 32, "..%2F..%2Fx", "0" * 32, "%2e%2e"]
)
def test_a_token_that_is_not_ours_is_a_404_and_builds_no_path(
    client: TestClient, tmp_path: Path, token: str
) -> None:
    assert client.get(f"/api/segments/import/{token}/audio").status_code == 404
    res = client.post("/api/segments/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (404, "segment_import_unknown")
    assert client.delete(f"/api/segments/import/{token}").status_code in (200, 404)


def test_a_token_in_the_body_cannot_name_another_file(client: TestClient, tmp_path: Path) -> None:
    secret = tmp_path / "secret.sharecutseg"
    secret.write_bytes(_file(tmp_path))
    res = client.post("/api/segments/import", json={"token": f"../../../{secret}"})
    assert res.status_code == 404 and secret.exists()


def test_a_file_that_is_not_a_bundle_is_refused_with_the_service_message(
    client: TestClient, staging_dir: Path
) -> None:
    res = client.post(PREVIEW, content=b"not a zip at all", headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (422, "segment_bundle_invalid")
    assert res.json()["detail"] == "This file is not a segment bundle."
    assert _staged(staging_dir) == []


def test_an_empty_upload_is_refused(client: TestClient, staging_dir: Path) -> None:
    _expect(client, b"", 422, "segment_bundle_invalid", staging_dir)


def test_a_forged_hash_is_refused_and_nothing_is_left(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    good = tmp_path / "good.sharecutseg"
    good.write_bytes(_file(tmp_path))
    forged = rewrite_zip(good, tmp_path / "f.sharecutseg", replace={"clip-01.flac": b"fLaC-onX"})
    _expect(client, forged.read_bytes(), 422, "segment_hash_mismatch", staging_dir)


def test_a_newer_schema_is_refused(client: TestClient, tmp_path: Path, staging_dir: Path) -> None:
    good = tmp_path / "good.sharecutseg"
    good.write_bytes(_file(tmp_path))
    with zipfile.ZipFile(good) as archive:
        data = archive.read("segment.json").replace(b'"schema_version": 1', b'"schema_version": 2')
    bad = rewrite_zip(good, tmp_path / "v2.sharecutseg", replace={"segment.json": data})
    _expect(client, bad.read_bytes(), 422, "segment_schema_unsupported", staging_dir)


def test_a_zip_bomb_is_refused_before_it_is_unpacked(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    path = tmp_path / "bomb.sharecutseg"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out:
        out.writestr("segment.json", "{}")
        out.writestr(MANIFEST, "")
        out.writestr("clip-01.flac", bytes(8 * 1024 * 1024))
    assert path.stat().st_size < 64 * 1024
    _expect(client, path.read_bytes(), 422, "segment_bundle_invalid", staging_dir)


def test_a_declared_size_over_the_cap_is_refused_before_any_byte_is_read(
    client: TestClient, staging_dir: Path
) -> None:
    res = client.post(
        PREVIEW,
        content=b"x",
        headers={**STREAM, "Content-Length": str(bundle.MAX_BUNDLE_BYTES + 1)},
    )
    assert (res.status_code, res.headers[CODE]) == (413, "segment_upload_too_large")
    assert _staged(staging_dir) == []


def test_the_cap_sits_below_the_two_gib_unpacked_limit() -> None:
    assert bundle.MAX_BUNDLE_BYTES < bundle.MAX_TOTAL_BYTES == 2 * 1024**3


def test_a_body_that_grows_past_the_cap_is_refused_and_its_partial_file_removed(
    client: TestClient, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(segment_import, "MAX_BUNDLE_BYTES", 1000)

    def chunks() -> Iterator[bytes]:
        for _ in range(20):
            yield b"x" * 100

    res = client.post(PREVIEW, content=chunks(), headers=STREAM)

    assert (res.status_code, res.headers[CODE]) == (413, "segment_upload_too_large")
    assert _staged(staging_dir) == []


def test_the_body_limit_middleware_lets_only_the_preview_path_past_four_mib(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    big = b"z" * (5 * 1024 * 1024)

    assert (
        client.post(PREVIEW, content=big, headers=STREAM).headers[CODE] == "segment_bundle_invalid"
    )
    for other in ("/api/segments/import", "/api/segments", PREVIEW + "/x"):
        res = client.post(other, content=big, headers=STREAM)
        assert (res.status_code, res.headers[CODE]) == (413, "payload_too_large")
    assert _staged(staging_dir) == []


def test_the_oldest_waiting_file_makes_room_when_every_slot_is_taken(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    tokens = []
    for n in range(MAX_STAGED):
        tokens.append(_preview(client, _file(tmp_path, audio=b"fLaC-%d" % n))["token"])
        past = time.time() - 100 + n
        os.utime(staging_dir / f"{tokens[-1]}.sharecutseg", (past, past))

    newest = _preview(client, _file(tmp_path, audio=b"fLaC-more"))["token"]

    assert len(_staged(staging_dir)) == MAX_STAGED
    assert f"{tokens[0]}.sharecutseg" not in _staged(staging_dir)
    assert f"{newest}.sharecutseg" in _staged(staging_dir)
    assert client.post("/api/segments/import", json={"token": tokens[0]}).status_code == 404


def test_parallel_previews_never_hold_more_slots_than_the_cap(staging_dir: Path) -> None:
    store = SegmentStore()
    staging = import_staging.ImportStaging(store)

    def start(_: int) -> None:
        upload = staging.begin(None)
        staging.open_partial(upload).close()
        staging.finish(upload)

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(start, range(12)))

    assert len(_staged(staging_dir)) <= MAX_STAGED


def test_a_client_that_left_before_the_answer_leaves_nothing_staged(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def gone(self: object) -> bool:
        return True

    monkeypatch.setattr(Request, "is_disconnected", gone)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert res.status_code == 400
    assert _staged(staging_dir) == []


def test_a_file_that_fails_the_commit_check_is_removed_but_a_busy_library_keeps_it(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]

    def forged(self: SegmentStore, folder: Path) -> object:
        raise CodedValueError("hash", code="segment_hash_mismatch")

    monkeypatch.setattr(SegmentStore, "add", forged)
    res = client.post("/api/segments/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (422, "segment_hash_mismatch")
    assert _staged(staging_dir) == []


def test_cancel_while_the_commit_runs_is_a_409_and_the_commit_still_finishes(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add
    seen: list[tuple[int, str]] = []

    def add(self: SegmentStore, folder: Path) -> object:
        res = client.delete(f"/api/segments/import/{token}")
        seen.append((res.status_code, res.headers.get(CODE, "")))
        return real(self, folder)

    monkeypatch.setattr(SegmentStore, "add", add)
    assert client.post("/api/segments/import", json={"token": token}).status_code == 200
    assert seen == [(409, "segment_import_committing")]
    assert [s.name for s in SegmentStore().list()] == ["Warm Intro"]


def test_a_chunked_upload_is_checked_against_free_space_as_it_grows(
    client: TestClient, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bundle, "free_bytes", lambda _path: 10)

    def chunks() -> Iterator[bytes]:
        yield b"x" * 100

    res = client.post(PREVIEW, content=chunks(), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (507, "segment_no_room")
    assert _staged(staging_dir) == []


def test_the_unpack_needs_room_for_the_headers_total_size(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(import_staging.ImportStaging, "ensure_room", lambda self, received: None)
    monkeypatch.setattr(bundle, "free_bytes", lambda _path: 1)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (507, "segment_no_room")
    assert _staged(staging_dir) == []


def test_files_older_than_an_hour_are_swept_on_the_next_preview(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    old = _preview(client, _file(tmp_path))["token"]
    stale = staging_dir / f"{old}.sharecutseg"
    past = time.time() - STAGED_TTL_SEC - 60
    os.utime(stale, (past, past))

    fresh = _preview(client, _file(tmp_path, audio=b"fLaC-two"))["token"]

    assert _staged(staging_dir) == [f"{fresh}.sharecutseg"]
    assert client.post("/api/segments/import", json={"token": old}).status_code == 404


def test_commit_and_cancel_sweep_too(client: TestClient, tmp_path: Path, staging_dir: Path) -> None:
    old = _preview(client, _file(tmp_path))["token"]
    keep = _preview(client, _file(tmp_path, audio=b"fLaC-two"))["token"]
    past = time.time() - STAGED_TTL_SEC - 60
    os.utime(staging_dir / f"{old}.sharecutseg", (past, past))

    client.delete(f"/api/segments/import/{keep}")

    assert _staged(staging_dir) == []


def test_too_little_disk_is_refused_before_the_upload_is_written(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bundle, "free_bytes", lambda _path: 10)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (507, "segment_no_room")
    assert _staged(staging_dir) == []


def test_every_import_route_refuses_a_foreign_origin_and_a_relayed_request(
    tmp_path: Path, staging_dir: Path
) -> None:
    segment_id = SegmentStore().add(make_segment_dir(tmp_path / "s")).id
    token = "a" * 32
    calls: list[tuple[str, str, dict[str, Any]]] = [
        ("GET", f"/api/segments/{segment_id}/export", {}),
        ("POST", PREVIEW, {"content": _file(tmp_path)}),
        ("GET", f"/api/segments/import/{token}/audio", {}),
        ("POST", "/api/segments/import", {"json": {"token": token}}),
        ("DELETE", f"/api/segments/import/{token}", {}),
    ]
    evil = TestClient(create_app(), client=("127.0.0.1", 50000))
    relayed = TestClient(
        create_app(), client=("127.0.0.1", 50000), headers={RELAYED_REQUEST_HEADER: "1"}
    )
    for method, path, kwargs in calls:
        assert (
            evil.request(
                method, path, headers={"Origin": "https://evil.example"}, **kwargs
            ).status_code
            == 403
        )
        assert relayed.request(method, path, **kwargs).status_code in (401, 403)
    assert _staged(staging_dir) == []
