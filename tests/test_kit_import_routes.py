"""``/api/kits`` list and export and ``/api/kits/import/*``: one file out, one file in, host only."""

from __future__ import annotations

import errno
import hashlib
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

from kit_helpers import hand_made_kit
from podcast_mcp.gui.routes import kit_import
from podcast_mcp.gui.server import create_app
from podcast_mcp.segments import bundle, import_staging, kit_bundle
from podcast_mcp.segments import store as segment_store
from podcast_mcp.segments.bundle import export_segments
from podcast_mcp.segments.import_staging import (
    KIT_KIND,
    MAX_STAGED,
    SEGMENT_KIND,
    STAGED_TTL_SEC,
    ImportStaging,
)
from podcast_mcp.segments.kit import KitEntry, KitFile, KitStore, kit_id_for
from podcast_mcp.segments.kit_bundle import export_kit
from podcast_mcp.segments.kit_summary import save_kit
from podcast_mcp.segments.store import AddResult, SegmentStore
from podcast_mcp.util.body_limits import KIT_IMPORT_PREVIEW_PATH
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER
from segment_helpers import make_segment_dir

CODE = "X-Sharecut-Error-Code"
PREVIEW = KIT_IMPORT_PREVIEW_PATH
STREAM = {"Content-Type": "application/octet-stream"}
KIT_ID = kit_id_for("Show Kit")


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
    return _config_dir / "kits" / ".staging"


def _file(tmp_path: Path, **kwargs: Any) -> bytes:
    return hand_made_kit(tmp_path, **kwargs).read_bytes()


def _preview(client: TestClient, data: bytes) -> dict[str, Any]:
    res = client.post(PREVIEW, content=data, headers=STREAM)
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _staged(staging_dir: Path) -> list[str]:
    return sorted(p.name for p in staging_dir.iterdir()) if staging_dir.is_dir() else []


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _expect(client: TestClient, data: bytes, status: int, code: str, staging_dir: Path) -> None:
    res = client.post(PREVIEW, content=data, headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (status, code), res.text
    assert _staged(staging_dir) == []
    assert KitStore().list() == [] and SegmentStore().list() == []


def _library_kit(tmp_path: Path) -> str:
    segments = SegmentStore()
    ids = [
        segments.add(make_segment_dir(tmp_path / "lib-in", name=n, audio=a)).id
        for n, a in (("Warm Intro", b"fLaC-one"), ("Sign Off", b"fLaC-two"))
    ]
    return save_kit(
        KitStore(), segments, "Show Kit", [KitEntry(segment_id=i, at="start") for i in ids]
    ).id


def test_list_describes_usable_unusable_and_damaged_kits_without_hashing_audio(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kit_id = _library_kit(tmp_path)
    ghost = SegmentStore(tmp_path / "ghosts").add(
        make_segment_dir(tmp_path / "ghost-in", name="Ghost", audio=b"fLaC-g")
    )
    KitStore().add(
        KitFile(
            id=kit_id_for("Broken Kit"),
            name="Broken Kit",
            entries=[KitEntry(segment_id=ghost.id, at="end")],
        )
    )
    damaged = KitStore().directory / kit_id_for("Odd Kit") / "v1"
    damaged.mkdir(parents=True)
    (damaged / "kit.json").write_text("{not json")

    def never(path: Path) -> str:
        raise AssertionError("audio must not be hashed")

    monkeypatch.setattr(segment_store, "sha256_file", never)
    res = client.get("/api/kits")

    assert res.status_code == 200
    rows = {row["id"]: row for row in res.json()}
    assert (rows[kit_id]["usable"], rows[kit_id]["entries"], rows[kit_id]["missing"]) == (
        True,
        2,
        0,
    )
    broken = rows[kit_id_for("Broken Kit")]
    assert (broken["usable"], broken["missing"]) == (False, 1)
    assert broken["problem"]
    odd = rows[kit_id_for("Odd Kit")]
    assert (odd["damaged"], odd["usable"]) == (True, False)
    assert odd["problem"]


def test_list_is_empty_for_a_new_library(client: TestClient) -> None:
    assert client.get("/api/kits").json() == []


def test_export_is_the_file_the_command_line_writes(client: TestClient, tmp_path: Path) -> None:
    kit_id = _library_kit(tmp_path)

    res = client.get(f"/api/kits/{kit_id}/export")

    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["content-disposition"] == 'attachment; filename="show-kit.sharecutkit"'
    cli = export_kit(KitStore(), SegmentStore(), kit_id, tmp_path / "cli.sharecutkit")
    served = tmp_path / "served.sharecutkit"
    served.write_bytes(res.content)
    with zipfile.ZipFile(served) as got, zipfile.ZipFile(cli) as want:
        assert sorted(got.namelist()) == sorted(want.namelist())
        assert all(got.read(name) == want.read(name) for name in want.namelist())


def test_export_of_an_unknown_kit_is_a_404(client: TestClient) -> None:
    res = client.get("/api/kits/nothing-00000000/export")
    assert (res.status_code, res.headers[CODE]) == (404, "kit_unknown")


def test_export_of_a_kit_with_a_missing_segment_is_a_409(
    client: TestClient, tmp_path: Path
) -> None:
    kit_id = _library_kit(tmp_path)
    SegmentStore().remove(SegmentStore().list()[0].id)
    res = client.get(f"/api/kits/{kit_id}/export")
    assert (res.status_code, res.headers[CODE]) == (409, "kit_segment_missing")


def _damage_audio(how: str) -> Path:
    segment = SegmentStore().list()[0]
    audio = SegmentStore().path(segment.id) / sorted(segment.media)[0]
    if how == "missing":
        audio.unlink()
    else:
        audio.write_bytes(b"x" * audio.stat().st_size)
    return audio


@pytest.mark.parametrize("how", ["corrupt", "missing"])
def test_export_of_a_kit_with_damaged_audio_is_a_409_and_leaves_no_part_file(
    client: TestClient, tmp_path: Path, how: str
) -> None:
    kit_id = _library_kit(tmp_path)
    _damage_audio(how)
    res = client.get(f"/api/kits/{kit_id}/export")
    assert (res.status_code, res.headers[CODE]) == (409, "kit_segment_missing")
    assert "Sign Off" in res.json()["detail"]
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(CodedValueError) as raised:
        export_kit(KitStore(), SegmentStore(), kit_id, out / "kit.sharecutkit")
    assert raised.value.code == "kit_segment_missing"
    assert list(out.iterdir()) == []


def test_export_over_the_cap_is_refused_and_leaves_no_scratch_folder(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kit_id = _library_kit(tmp_path)
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    monkeypatch.setattr(kit_bundle, "MAX_BUNDLE_BYTES", 10)

    res = client.get(f"/api/kits/{kit_id}/export")

    assert (res.status_code, res.headers[CODE]) == (422, "kit_bundle_too_large")
    assert list(scratch.iterdir()) == []


def test_a_refused_export_keeps_the_file_at_the_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kit_id = _library_kit(tmp_path)
    target = tmp_path / "mine.sharecutkit"
    target.write_bytes(b"earlier")
    monkeypatch.setattr(kit_bundle, "MAX_BUNDLE_BYTES", 10)
    with pytest.raises(CodedValueError):
        export_kit(KitStore(), SegmentStore(), kit_id, target)
    assert target.read_bytes() == b"earlier"


def test_preview_describes_the_file_and_adds_nothing(
    client: TestClient, tmp_path: Path, staging_dir: Path, _config_dir: Path
) -> None:
    before = _tree(_config_dir) if _config_dir.exists() else {}

    body = _preview(client, _file(tmp_path))

    assert {k: v for k, v in body.items() if k not in {"token", "entries"}} == {
        "name": "Show Kit",
        "kit_id": KIT_ID,
        "outcome": "added",
        "version": 1,
        "entry_count": 2,
        "counts": {"added": 2, "new_version": 0, "unchanged": 0},
    }
    assert [
        (e["position"], e["name"], e["kind"], e["at"], e["outcome"], e["version"])
        for e in body["entries"]
    ] == [
        (1, "Warm Intro", "intro", "start", "added", 1),
        (2, "Sign Off", "intro", "end", "added", 1),
    ]
    assert KitStore().list() == [] and SegmentStore().list() == []
    assert _staged(staging_dir) == [f"{body['token']}.sharecutkit"]
    assert stat.S_IMODE(staging_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE((staging_dir / _staged(staging_dir)[0]).stat().st_mode) == 0o600
    after = _tree(_config_dir)
    assert {k: v for k, v in after.items() if ".staging" not in k} == before
    assert not (_config_dir / "segments" / ".staging").exists()


def test_preview_plans_two_versions_of_one_segment_in_order(
    client: TestClient, tmp_path: Path
) -> None:
    body = _preview(
        client,
        _file(tmp_path, members=(("Warm Intro", b"fLaC-one", 1), ("Warm Intro", b"fLaC-two", 2))),
    )
    assert [(e["outcome"], e["version"]) for e in body["entries"]] == [
        ("added", 1),
        ("new_version", 2),
    ]
    assert body["counts"] == {"added": 1, "new_version": 1, "unchanged": 0}


def test_commit_adds_the_kit_and_its_segments_and_clears_staging(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]

    res = client.post("/api/kits/import", json={"token": token})

    assert res.status_code == 200
    body = res.json()
    assert (body["kit"]["status"], body["kit"]["version"]) == ("added", 1)
    assert [s["status"] for s in body["segments"]] == ["added", "added"]
    assert [k.name for k in KitStore().list()] == ["Show Kit"]
    assert sorted(s.name for s in SegmentStore().list()) == ["Sign Off", "Warm Intro"]
    assert _staged(staging_dir) == []


def test_the_commit_answers_what_the_preview_said(client: TestClient, tmp_path: Path) -> None:
    data = _file(tmp_path, members=(("Warm Intro", b"fLaC-one", 1), ("Warm Intro", b"fLaC-two", 2)))
    preview = _preview(client, data)
    done = client.post("/api/kits/import", json={"token": preview["token"]}).json()
    assert [(s["status"], s["version"]) for s in done["segments"]] == [
        (e["outcome"], e["version"]) for e in preview["entries"]
    ]
    assert (done["kit"]["status"], done["kit"]["version"]) == (
        preview["outcome"],
        preview["version"],
    )


def test_the_same_file_again_is_unchanged_and_new_entries_are_a_new_version(
    client: TestClient, tmp_path: Path
) -> None:
    data = _file(tmp_path)
    client.post("/api/kits/import", json={"token": _preview(client, data)["token"]})

    again = _preview(client, data)
    assert again["outcome"] == "unchanged"
    assert again["counts"] == {"added": 0, "new_version": 0, "unchanged": 2}
    assert (
        client.post("/api/kits/import", json={"token": again["token"]}).json()["kit"]["status"]
        == "unchanged"
    )

    changed = _preview(
        client, _file(tmp_path, members=(("Warm Intro", b"fLaC-one", 1), ("Outro", b"fLaC-3", 1)))
    )
    assert (changed["outcome"], changed["version"]) == ("new_version", 2)
    done = client.post("/api/kits/import", json={"token": changed["token"]}).json()
    assert (done["kit"]["status"], done["kit"]["version"]) == ("new_version", 2)
    assert KitStore().versions(KIT_ID) == [1, 2]


def test_a_commit_body_names_the_token_and_nothing_else(client: TestClient) -> None:
    res = client.post("/api/kits/import", json={"token": "a" * 32, "on_conflict": "skip"})
    assert res.status_code == 422


def test_a_token_commits_once(client: TestClient, tmp_path: Path) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200
    again = client.post("/api/kits/import", json={"token": token})
    assert (again.status_code, again.headers[CODE]) == (404, "kit_import_unknown")


@pytest.mark.parametrize("code", ["kit_no_room", "kit_write_failed", "kit_busy"])
def test_a_kit_that_cannot_be_written_keeps_the_staged_file_for_a_retry(
    client: TestClient,
    tmp_path: Path,
    staging_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = KitStore.add

    def failing(self: KitStore, kit: object, *, keep_existing: bool = False) -> object:
        raise CodedValueError("kit", code=code)

    monkeypatch.setattr(KitStore, "add", failing)
    res = client.post("/api/kits/import", json={"token": token})
    assert res.headers[CODE] == code
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]

    monkeypatch.setattr(KitStore, "add", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200
    assert _staged(staging_dir) == []


@pytest.mark.parametrize(
    ("code", "status"),
    [("segment_no_room", 507), ("segment_write_failed", 500), ("segment_busy", 409)],
)
def test_a_segment_that_cannot_be_written_first_keeps_the_file_and_names_the_kit_code(
    client: TestClient,
    tmp_path: Path,
    staging_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    status: int,
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add

    def failing(self: SegmentStore, folder: Path) -> AddResult:
        raise CodedValueError("segment", code=code)

    monkeypatch.setattr(SegmentStore, "add", failing)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (status, code.replace("segment_", "kit_"))
    assert "segments_added" not in res.json()
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]

    monkeypatch.setattr(SegmentStore, "add", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200


@pytest.mark.parametrize(
    ("errno_", "code", "status"),
    [(errno.ENOSPC, "kit_no_room", 507), (errno.EIO, "kit_write_failed", 500)],
)
def test_a_disk_error_while_the_commit_unpacks_keeps_the_file_for_a_retry(
    client: TestClient,
    tmp_path: Path,
    staging_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    errno_: int,
    code: str,
    status: int,
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = Path.mkdir

    def failing(self: Path, *args: Any, **kwargs: Any) -> None:
        if self.name.startswith("seg0"):
            raise OSError(errno_, os.strerror(errno_))
        real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", failing)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (status, code)
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]
    assert KitStore().list() == [] and SegmentStore().list() == []

    monkeypatch.setattr(Path, "mkdir", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200
    assert _staged(staging_dir) == []


def test_a_disk_error_after_a_segment_landed_names_it_and_keeps_the_file(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add
    calls: list[int] = []

    def failing(self: SegmentStore, folder: Path) -> AddResult:
        calls.append(1)
        if len(calls) == 2:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(self, folder)

    monkeypatch.setattr(SegmentStore, "add", failing)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (507, "kit_no_room")
    body = res.json()
    assert [s["status"] for s in body["segments_added"]] == ["added"]
    assert body["segments_total"] == 2
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]

    monkeypatch.setattr(SegmentStore, "add", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200


def test_a_deterministic_failure_after_a_segment_landed_names_it_and_removes_the_file(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = KitStore.add

    def failing(self: KitStore, kit: object, *, keep_existing: bool = False) -> object:
        raise CodedValueError("The kit is not valid.", code="kit_invalid")

    monkeypatch.setattr(KitStore, "add", failing)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (422, "kit_invalid")
    assert len(res.json()["segments_added"]) == 2
    assert _staged(staging_dir) == []
    assert client.post("/api/kits/import", json={"token": token}).status_code == 404

    monkeypatch.setattr(KitStore, "add", real)


def test_a_partial_failure_names_the_segments_that_landed_and_a_retry_finishes(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add
    calls: list[int] = []

    def flaky(self: SegmentStore, folder: Path) -> AddResult:
        calls.append(1)
        if len(calls) == 2:
            raise CodedValueError("The library is busy.", code="segment_busy")
        return real(self, folder)

    monkeypatch.setattr(SegmentStore, "add", flaky)
    res = client.post("/api/kits/import", json={"token": token})

    assert (res.status_code, res.headers[CODE]) == (409, "kit_busy")
    body = res.json()
    assert [(s["status"], s["version"]) for s in body["segments_added"]] == [("added", 1)]
    assert body["segments_total"] == 2
    assert "kit was not saved" in body["detail"]
    assert KitStore().list() == []
    assert [s.name for s in SegmentStore().list()] == ["Warm Intro"]
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]

    monkeypatch.setattr(SegmentStore, "add", real)
    done = client.post("/api/kits/import", json={"token": token}).json()
    assert [s["status"] for s in done["segments"]] == ["unchanged", "added"]
    assert done["kit"]["status"] == "added"
    assert _staged(staging_dir) == []


def test_a_kit_write_that_fails_after_its_segments_landed_is_incomplete_and_kept(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = KitStore.add

    def failing(self: KitStore, kit: object, *, keep_existing: bool = False) -> object:
        raise CodedValueError("disk", code="kit_write_failed")

    monkeypatch.setattr(KitStore, "add", failing)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (500, "kit_write_failed")
    assert len(res.json()["segments_added"]) == 2
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]

    monkeypatch.setattr(KitStore, "add", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200


def test_a_cancel_that_loses_the_race_to_a_commit_is_a_409(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    claimed = staging_dir / f".claim-{token}"
    (staging_dir / f"{token}.sharecutkit").rename(claimed)
    res = client.delete(f"/api/kits/import/{token}")
    assert (res.status_code, res.headers[CODE]) == (409, "kit_import_committing")
    assert claimed.exists()


def test_cancel_while_the_commit_runs_is_a_409_and_the_commit_still_finishes(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add
    seen: list[tuple[int, str]] = []

    def add(self: SegmentStore, folder: Path) -> AddResult:
        res = client.delete(f"/api/kits/import/{token}")
        seen.append((res.status_code, res.headers.get(CODE, "")))
        return real(self, folder)

    monkeypatch.setattr(SegmentStore, "add", add)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200
    assert seen == [(409, "kit_import_committing")] * 2
    assert [k.name for k in KitStore().list()] == ["Show Kit"]


def test_cancel_removes_the_file_and_asking_again_is_fine(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    res = client.delete(f"/api/kits/import/{token}")
    assert (res.status_code, res.json()) == (200, {"cancelled": token})
    assert _staged(staging_dir) == []
    assert client.delete(f"/api/kits/import/{token}").status_code == 200
    assert client.post("/api/kits/import", json={"token": token}).status_code == 404


@pytest.mark.parametrize(
    "token", ["0" * 31, "0" * 33, "A" * 32, "g" * 32, "..%2F..%2Fx", "0" * 32, "%2e%2e"]
)
def test_a_token_that_is_not_ours_is_a_404_and_builds_no_path(
    client: TestClient, token: str
) -> None:
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (404, "kit_import_unknown")
    assert client.delete(f"/api/kits/import/{token}").status_code in (200, 404)


def test_a_token_in_the_body_cannot_name_another_file(client: TestClient, tmp_path: Path) -> None:
    secret = tmp_path / "secret.sharecutkit"
    secret.write_bytes(_file(tmp_path))
    res = client.post("/api/kits/import", json={"token": f"../../../{secret}"})
    assert res.status_code == 404 and secret.exists()


def test_a_cancel_with_a_wildcard_token_removes_nothing(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    client.delete("/api/kits/import/*")
    client.delete("/api/kits/import/..")
    client.delete("/api/kits/import/" + token[:8] + "*")
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]


def test_a_symlink_in_the_staging_folder_is_not_a_waiting_file(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = "a" * 32
    target = tmp_path / "elsewhere.sharecutkit"
    target.write_bytes(_file(tmp_path))
    staging_dir.mkdir(parents=True, exist_ok=True)
    (staging_dir / f"{token}.sharecutkit").symlink_to(target)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (404, "kit_import_unknown")
    assert KitStore().list() == [] and target.exists()


def test_a_file_that_is_not_a_bundle_is_refused_with_the_service_message(
    client: TestClient, staging_dir: Path
) -> None:
    res = client.post(PREVIEW, content=b"not a zip at all", headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (422, "kit_bundle_invalid")
    assert "is not a kit bundle" in res.json()["detail"]
    assert _staged(staging_dir) == []


def test_an_empty_upload_is_refused(client: TestClient, staging_dir: Path) -> None:
    _expect(client, b"", 422, "kit_bundle_invalid", staging_dir)


def test_a_segment_file_sent_to_the_kit_route_is_refused(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    library = SegmentStore(tmp_path / "seg-lib")
    seg = library.add(make_segment_dir(tmp_path / "in", name="Warm Intro"))
    data = export_segments(library, [seg.id], tmp_path / "w.sharecutseg").read_bytes()
    _expect(client, data, 422, "kit_bundle_invalid", staging_dir)


def test_a_forged_hash_is_refused_and_nothing_is_left(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    good = hand_made_kit(tmp_path)
    forged = tmp_path / "forged.sharecutkit"
    with zipfile.ZipFile(good) as source, zipfile.ZipFile(forged, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            target.writestr(
                info.filename, b"fLaC-onX" if info.filename.endswith("clip-01.flac") else data
            )
    _expect(client, forged.read_bytes(), 422, "kit_hash_mismatch", staging_dir)


def test_a_newer_schema_is_refused(client: TestClient, tmp_path: Path, staging_dir: Path) -> None:
    good = hand_made_kit(tmp_path)
    bad = tmp_path / "v2.sharecutkit"
    with zipfile.ZipFile(good) as source:
        members = {i.filename: source.read(i) for i in source.infolist()}
    members["kit.json"] = members["kit.json"].replace(
        b'"schema_version": 1', b'"schema_version": 2'
    )
    members["MANIFEST.sha256"] = "".join(
        f"{hashlib.sha256(d).hexdigest()}  {n}\n"
        for n, d in members.items()
        if n != "MANIFEST.sha256"
    ).encode()
    with zipfile.ZipFile(bad, "w") as target:
        for name, data in members.items():
            target.writestr(name, data)
    _expect(client, bad.read_bytes(), 422, "kit_schema_unsupported", staging_dir)


def test_a_file_that_fails_the_commit_check_is_removed(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]

    def forged(self: SegmentStore, folder: Path) -> AddResult:
        raise CodedValueError("hash", code="segment_hash_mismatch")

    monkeypatch.setattr(SegmentStore, "add", forged)
    res = client.post("/api/kits/import", json={"token": token})
    assert (res.status_code, res.headers[CODE]) == (422, "kit_hash_mismatch")
    assert _staged(staging_dir) == []


def test_a_zip_bomb_is_refused_before_it_is_unpacked(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    path = tmp_path / "bomb.sharecutkit"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out:
        out.writestr("kit.json", "{}")
        out.writestr("MANIFEST.sha256", "")
        out.writestr("seg01__clip-01.flac", bytes(8 * 1024 * 1024))
    assert path.stat().st_size < 64 * 1024
    _expect(client, path.read_bytes(), 422, "kit_bundle_invalid", staging_dir)


def test_a_declared_size_over_the_cap_is_refused_before_any_byte_is_read(
    client: TestClient, staging_dir: Path
) -> None:
    res = client.post(
        PREVIEW,
        content=b"x",
        headers={**STREAM, "Content-Length": str(bundle.MAX_BUNDLE_BYTES + 1)},
    )
    assert (res.status_code, res.headers[CODE]) == (413, "kit_upload_too_large")
    assert _staged(staging_dir) == []


def test_a_body_that_grows_past_the_cap_is_refused_and_its_partial_file_removed(
    client: TestClient, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kit_import, "MAX_BUNDLE_BYTES", 1000)

    def chunks() -> Iterator[bytes]:
        for _ in range(20):
            yield b"x" * 100

    res = client.post(PREVIEW, content=chunks(), headers=STREAM)

    assert (res.status_code, res.headers[CODE]) == (413, "kit_upload_too_large")
    assert _staged(staging_dir) == []


def test_the_body_limit_middleware_lets_only_the_kit_preview_path_past_four_mib(
    client: TestClient, staging_dir: Path
) -> None:
    big = b"z" * (5 * 1024 * 1024)

    assert client.post(PREVIEW, content=big, headers=STREAM).headers[CODE] == "kit_bundle_invalid"
    for other in ("/api/kits/import", "/api/kits/apply", PREVIEW + "/x"):
        res = client.post(other, content=big, headers=STREAM)
        assert (res.status_code, res.headers[CODE]) == (413, "payload_too_large")
    assert _staged(staging_dir) == []


def test_the_oldest_waiting_file_makes_room_when_every_slot_is_taken(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    tokens = []
    for n in range(MAX_STAGED):
        tokens.append(
            _preview(client, _file(tmp_path, members=(("Warm Intro", b"fLaC-%d" % n, 1),)))["token"]
        )
        past = time.time() - 100 + n
        os.utime(staging_dir / f"{tokens[-1]}.sharecutkit", (past, past))

    newest = _preview(client, _file(tmp_path, members=(("Warm Intro", b"fLaC-more", 1),)))["token"]

    assert len(_staged(staging_dir)) == MAX_STAGED
    assert f"{tokens[0]}.sharecutkit" not in _staged(staging_dir)
    assert f"{newest}.sharecutkit" in _staged(staging_dir)
    assert client.post("/api/kits/import", json={"token": tokens[0]}).status_code == 404


def test_a_kit_preview_never_evicts_a_segment_preview(
    client: TestClient, tmp_path: Path, _config_dir: Path
) -> None:
    segment_staging = ImportStaging(SegmentStore())
    upload = segment_staging.begin(None)
    segment_staging.open_partial(upload).close()
    segment_staging.finish(upload)
    for n in range(MAX_STAGED + 1):
        _preview(client, _file(tmp_path, members=(("Warm Intro", b"fLaC-%d" % n, 1),)))
    assert (_config_dir / "segments" / ".staging" / f"{upload.token}.sharecutseg").exists()


def test_parallel_previews_never_hold_more_slots_than_the_cap(staging_dir: Path) -> None:
    staging = ImportStaging(KitStore(), KIT_KIND)

    def start(_: int) -> str | None:
        try:
            upload = staging.begin(None)
        except CodedValueError as exc:
            assert exc.code == "kit_staging_full"
            return None
        staging.open_partial(upload).close()
        staging.finish(upload)
        return upload.token

    with ThreadPoolExecutor(8) as pool:
        tokens = [t for t in pool.map(start, range(12)) if t is not None]

    staged = _staged(staging_dir)
    assert len(tokens) >= MAX_STAGED
    assert len(staged) == MAX_STAGED
    assert all(name.removesuffix(".sharecutkit") in tokens for name in staged)
    assert all(name.endswith(".sharecutkit") for name in staged)


def test_a_full_staging_folder_of_uploads_in_progress_answers_429(staging_dir: Path) -> None:
    staging = ImportStaging(KitStore(), KIT_KIND)
    held = [staging.begin(None) for _ in range(MAX_STAGED)]
    with pytest.raises(CodedValueError) as raised:
        staging.begin(None)
    assert raised.value.code == "kit_staging_full"
    assert len(held) == MAX_STAGED


def test_the_staging_full_refusal_is_a_429_over_http(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def full(self: ImportStaging, declared: int | None) -> object:
        raise CodedValueError("busy", code="kit_staging_full")

    monkeypatch.setattr(ImportStaging, "begin", full)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (429, "kit_staging_full")


def test_a_client_that_left_before_the_answer_leaves_nothing_staged(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def gone(self: object) -> bool:
        return True

    monkeypatch.setattr(Request, "is_disconnected", gone)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (400, "kit_upload_cancelled")
    assert _staged(staging_dir) == []


def test_a_chunked_upload_is_checked_against_free_space_as_it_grows(
    client: TestClient, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bundle, "free_bytes", lambda _path: 10)

    def chunks() -> Iterator[bytes]:
        yield b"x" * 100

    res = client.post(PREVIEW, content=chunks(), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (507, "kit_no_room")
    assert _staged(staging_dir) == []


def test_a_declared_length_the_disk_cannot_take_is_refused_before_the_body(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bundle, "free_bytes", lambda _path: 1)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (507, "kit_no_room")
    assert _staged(staging_dir) == []


def test_the_unpack_needs_room_for_the_headers_total_size(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ImportStaging, "ensure_room", lambda self, received: None)
    monkeypatch.setattr(ImportStaging, "begin", _begin_without_room_check(ImportStaging.begin))
    monkeypatch.setattr(bundle, "free_bytes", lambda _path: 1)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (507, "kit_no_room")
    assert _staged(staging_dir) == []


def _begin_without_room_check(real: Any) -> Any:
    def begin(self: ImportStaging, declared: int | None) -> object:
        return real(self, None)

    return begin


def test_a_write_failure_while_staging_is_a_500_with_the_kit_code(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(self: ImportStaging, upload: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(ImportStaging, "finish", broken)
    res = client.post(PREVIEW, content=_file(tmp_path), headers=STREAM)
    assert (res.status_code, res.headers[CODE]) == (500, "kit_write_failed")
    assert _staged(staging_dir) == []


def test_files_older_than_an_hour_are_swept_on_the_next_preview(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    old = _preview(client, _file(tmp_path))["token"]
    stale = staging_dir / f"{old}.sharecutkit"
    past = time.time() - STAGED_TTL_SEC - 60
    os.utime(stale, (past, past))

    fresh = _preview(client, _file(tmp_path, members=(("Warm Intro", b"fLaC-two", 1),)))["token"]

    assert _staged(staging_dir) == [f"{fresh}.sharecutkit"]
    assert client.post("/api/kits/import", json={"token": old}).status_code == 404


def test_every_kit_file_route_refuses_a_foreign_origin_and_a_relayed_request(
    tmp_path: Path, staging_dir: Path
) -> None:
    kit_id = _library_kit(tmp_path)
    token = "a" * 32
    calls: list[tuple[str, str, dict[str, Any]]] = [
        ("GET", "/api/kits", {}),
        ("GET", f"/api/kits/{kit_id}/export", {}),
        ("POST", PREVIEW, {"content": _file(tmp_path)}),
        ("POST", "/api/kits/import", {"json": {"token": token}}),
        ("DELETE", f"/api/kits/import/{token}", {}),
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
        refused = relayed.request(method, path, **kwargs)
        assert (refused.status_code, refused.headers[CODE]) == (403, "authz_denied")
    assert _staged(staging_dir) == []


@pytest.mark.parametrize("kind", [SEGMENT_KIND, KIT_KIND])
def test_the_kept_file_codes_follow_the_kind(kind: import_staging.StagedKind) -> None:
    assert kind.keeps_file == {
        f"{kind.name}_busy",
        f"{kind.name}_no_room",
        f"{kind.name}_write_failed",
    }


def test_a_staged_kit_has_no_clips(staging_dir: Path) -> None:
    with pytest.raises(AssertionError):
        ImportStaging(KitStore(), KIT_KIND).clip("a" * 32, 0)


def _expire(staging_dir: Path, token: str) -> None:
    past = time.time() - STAGED_TTL_SEC - 60
    os.utime(staging_dir / f"{token}.sharecutkit", (past, past))


def test_a_commit_sweeps_an_expired_staged_file_and_answers_unknown(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    _expire(staging_dir, token)

    res = client.post("/api/kits/import", json={"token": token})

    assert (res.status_code, res.headers[CODE]) == (404, "kit_import_unknown")
    assert _staged(staging_dir) == []
    assert KitStore().list() == [] and SegmentStore().list() == []


def test_a_cancel_sweeps_an_expired_staged_file_and_keeps_a_fresh_one(
    client: TestClient, tmp_path: Path, staging_dir: Path
) -> None:
    expired = _preview(client, _file(tmp_path))["token"]
    other = _preview(client, _file(tmp_path, members=(("Warm Intro", b"fLaC-two", 1),)))["token"]
    _expire(staging_dir, expired)

    res = client.delete(f"/api/kits/import/{'b' * 32}")

    assert res.status_code == 200
    assert _staged(staging_dir) == [f"{other}.sharecutkit"]
    assert client.post("/api/kits/import", json={"token": expired}).status_code == 404


def test_a_retry_after_only_unchanged_segments_answers_the_plain_refusal(
    client: TestClient, tmp_path: Path, staging_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = SegmentStore.add
    state = {"calls": 0, "fail_from": 2}

    def flaky(self: SegmentStore, folder: Path) -> AddResult:
        state["calls"] += 1
        if state["calls"] >= state["fail_from"]:
            raise CodedValueError("The library is busy.", code="segment_busy")
        return real(self, folder)

    monkeypatch.setattr(SegmentStore, "add", flaky)
    first = client.post("/api/kits/import", json={"token": token})
    assert [s["status"] for s in first.json()["segments_added"]] == ["added"]

    state.update(calls=0, fail_from=2)  # the first segment is now unchanged, the second fails
    res = client.post("/api/kits/import", json={"token": token})

    assert (res.status_code, res.headers[CODE]) == (409, "kit_busy")
    assert "segments_added" not in res.json() and "segments_total" not in res.json()
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]
    assert KitStore().list() == []

    monkeypatch.setattr(SegmentStore, "add", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200


@pytest.mark.parametrize(
    ("errno_", "code", "status"),
    [(errno.ENOSPC, "kit_no_room", 507), (errno.EIO, "kit_write_failed", 500)],
)
def test_a_kit_write_that_raises_oserror_after_segments_landed_is_incomplete_and_kept(
    client: TestClient,
    tmp_path: Path,
    staging_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    errno_: int,
    code: str,
    status: int,
) -> None:
    token = _preview(client, _file(tmp_path))["token"]
    real = KitStore.add

    def failing(self: KitStore, kit: object, *, keep_existing: bool = False) -> object:
        raise OSError(errno_, os.strerror(errno_))

    monkeypatch.setattr(KitStore, "add", failing)
    res = client.post("/api/kits/import", json={"token": token})

    assert (res.status_code, res.headers[CODE]) == (status, code)
    body = res.json()
    assert [s["status"] for s in body["segments_added"]] == ["added", "added"]
    assert body["segments_total"] == 2
    assert _staged(staging_dir) == [f"{token}.sharecutkit"]
    assert KitStore().list() == []

    monkeypatch.setattr(KitStore, "add", real)
    assert client.post("/api/kits/import", json={"token": token}).status_code == 200
    assert _staged(staging_dir) == []


def test_preview_entries_carry_the_note_and_the_duration(
    client: TestClient, tmp_path: Path
) -> None:
    segments = SegmentStore()
    ids = [
        segments.add(make_segment_dir(tmp_path / "lib-in", name=n, audio=a)).id
        for n, a in (("Warm Intro", b"fLaC-one"), ("Sign Off", b"fLaC-two"))
    ]
    kit_id = save_kit(
        KitStore(),
        segments,
        "Show Kit",
        [
            KitEntry(segment_id=ids[0], at="start", note="open cold"),
            KitEntry(segment_id=ids[1], at="end"),
        ],
    ).id
    exported = client.get(f"/api/kits/{kit_id}/export").content

    entries = _preview(client, exported)["entries"]

    assert [(e["name"], e["note"], e["duration_sec"]) for e in entries] == [
        ("Warm Intro", "open cold", 2.0),
        ("Sign Off", None, 2.0),
    ]


def test_every_kit_file_route_refuses_a_foreign_host(tmp_path: Path, staging_dir: Path) -> None:
    kit_id = _library_kit(tmp_path)
    token = "a" * 32
    calls: list[tuple[str, str, dict[str, Any]]] = [
        ("GET", "/api/kits", {}),
        ("GET", f"/api/kits/{kit_id}/export", {}),
        ("POST", PREVIEW, {"content": _file(tmp_path)}),
        ("POST", "/api/kits/import", {"json": {"token": token}}),
        ("DELETE", f"/api/kits/import/{token}", {}),
    ]
    foreign = TestClient(create_app(), client=("127.0.0.1", 50000))
    for method, path, kwargs in calls:
        res = foreign.request(method, path, headers={"Host": "evil.example"}, **kwargs)
        assert res.status_code == 400, (method, path, res.status_code)
    assert _staged(staging_dir) == []
    assert len(KitStore().list()) == 1
