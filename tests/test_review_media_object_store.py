"""Review MP3 + optional object-store bypass for guest ReviewApp audio."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.review_versions import get_version
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.runtime_config import RuntimeConfigError
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.review_media import (
    media_type_for_path,
    presign_ttl_seconds,
    review_guest_audio_path,
    upload_review_version_to_object_store,
)
from podcast_mcp.services.share import ShareService
from podcast_mcp.util.object_store import (
    ObjectStoreClient,
    ObjectStoreConfig,
    load_object_store_config,
    resolve_object_store_client,
)


class _FakeObjectStore:
    def __init__(self) -> None:
        self.uploaded: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.bucket = "test-bucket"

    def upload_file(
        self,
        local_path: Path,
        object_key: str,
        *,
        content_type: str = "audio/mpeg",
        acl: str = "private",
    ) -> None:
        assert local_path.is_file()
        assert content_type == "audio/mpeg"
        assert acl in {"private", "public-read"}
        self.uploaded.append((str(local_path), object_key))

    def presigned_get_url(self, object_key: str, *, expires_in: int) -> str:
        assert expires_in >= 3600
        return f"https://object-store.example.test/{object_key}?expires={expires_in}"

    def delete_object(self, object_key: str) -> None:
        self.deleted.append(object_key)


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_presign_ttl_clamped():
    assert presign_ttl_seconds(None) == 24 * 3600
    far = (datetime.now(UTC) + timedelta(days=10)).isoformat()
    assert presign_ttl_seconds(far) == 24 * 3600
    near = (datetime.now(UTC) + timedelta(minutes=30)).isoformat()
    assert presign_ttl_seconds(near) == 3600
    mid = (datetime.now(UTC) + timedelta(hours=6)).isoformat()
    assert 3600 <= presign_ttl_seconds(mid) <= 24 * 3600


def test_media_type_for_path():
    assert media_type_for_path(Path("mix.mp3")) == "audio/mpeg"
    assert media_type_for_path(Path("mix.wav")) == "audio/wav"


def test_load_object_store_config_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("PODCAST_OBJECT_STORE_ENDPOINT_URL", "https://s3.example.test")
    monkeypatch.setenv("PODCAST_OBJECT_STORE_REGION", "us-test-1")
    monkeypatch.setenv("PODCAST_OBJECT_STORE_BUCKET", "b")
    monkeypatch.setenv("PODCAST_OBJECT_STORE_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY", "s")
    cfg = load_object_store_config(tmp_path / "missing.yaml")
    assert cfg is not None
    assert cfg.bucket == "b"
    assert cfg.region == "us-test-1"


def test_load_object_store_config_from_yaml(tmp_path, monkeypatch):
    for key in (
        "PODCAST_OBJECT_STORE_ENDPOINT_URL",
        "PODCAST_OBJECT_STORE_REGION",
        "PODCAST_OBJECT_STORE_BUCKET",
        "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
        "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
        "PODCAST_OBJECT_STORE_CDN_ENDPOINT",
    ):
        monkeypatch.delenv(key, raising=False)
    path = tmp_path / "relay.yaml"
    path.write_text(
        "\n".join(
            [
                "object_store:",
                "  endpoint_url: https://s3.example.test",
                "  region: us-test-1",
                "  bucket: podcast-review-tmp",
                "  access_key_id: key",
                "  secret_access_key: secret",
                "  cdn_endpoint: https://cdn.example",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    cfg = load_object_store_config(path)
    assert cfg == ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="podcast-review-tmp",
        access_key_id="key",
        secret_access_key="secret",
        cdn_endpoint="https://cdn.example",
    )


def test_review_guest_audio_prefers_mp3(minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="mp3")
    path = review_guest_audio_path(ws.project, ver["id"])
    assert path.suffix == ".mp3"
    assert path.is_file()


def test_share_audio_mp3_without_object_store(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    for key in (
        "PODCAST_OBJECT_STORE_ENDPOINT_URL",
        "PODCAST_OBJECT_STORE_REGION",
        "PODCAST_OBJECT_STORE_BUCKET",
        "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
        "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="local-mp3")
    share = ShareService(ws).create(review_version_id=ver["id"])
    client = TestClient(create_app())
    audio = client.get(f"/api/review/{share['token']}/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/mpeg")


def test_share_audio_redirects_when_object_store_uploaded(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    fake = _FakeObjectStore()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="test-bucket",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="object_store")
    share = ShareService(ws).create(review_version_id=ver["id"])
    assert fake.uploaded
    ws = ProjectWorkspace.open(minimal_project)
    assert get_version(ws.project, ver["id"]).object_store_key

    client = TestClient(create_app(), follow_redirects=False)
    audio = client.get(f"/api/review/{share['token']}/audio")
    assert audio.status_code == 302
    assert audio.headers["location"].startswith("https://object-store.example.test/review/")


def test_revoke_deletes_object_store_object_when_unused(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    fake = _FakeObjectStore()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="test-bucket",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="revoke-object_store")
    share = ShareService(ws).create(review_version_id=ver["id"])
    assert fake.uploaded
    ShareService(ws).revoke(share["token"])
    assert fake.deleted
    ws = ProjectWorkspace.open(minimal_project)
    assert get_version(ws.project, ver["id"]).object_store_key is None


def test_upload_idempotent(minimal_project, sample_wav, monkeypatch):
    fake = _FakeObjectStore()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="test-bucket",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="once")
    key1 = upload_review_version_to_object_store(ws, ver["id"], object_store=cfg)
    key2 = upload_review_version_to_object_store(ws, ver["id"], object_store=cfg)
    assert key1 == key2
    assert len(fake.uploaded) == 1


def test_load_object_store_config_incomplete_mapping(tmp_path, monkeypatch):
    for key in (
        "PODCAST_OBJECT_STORE_ENDPOINT_URL",
        "PODCAST_OBJECT_STORE_REGION",
        "PODCAST_OBJECT_STORE_BUCKET",
        "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
        "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    path = tmp_path / "relay.yaml"
    path.write_text("object_store:\n  bucket: only\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="object_store is incomplete"):
        load_object_store_config(path)


def test_load_object_store_config_bad_yaml(tmp_path, monkeypatch):
    for key in (
        "PODCAST_OBJECT_STORE_ENDPOINT_URL",
        "PODCAST_OBJECT_STORE_REGION",
        "PODCAST_OBJECT_STORE_BUCKET",
        "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
        "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    path = tmp_path / "relay.yaml"
    path.write_text("object_store: [\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="cannot parse relay config"):
        load_object_store_config(path)
    path.write_text("- just a list\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError, match="must contain a YAML mapping"):
        load_object_store_config(path)
    path.write_text("relay_url: x\n", encoding="utf-8")
    assert load_object_store_config(path) is None
    assert load_object_store_config(tmp_path / "missing.yaml") is None


def test_resolve_object_store_client_handles_disabled_config_and_existing_client() -> None:
    existing = _FakeObjectStore()
    assert resolve_object_store_client(None, config_loader=lambda: None) is None
    assert resolve_object_store_client(existing) is existing

    config = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="region-1",
        bucket="media",
        access_key_id="key",
        secret_access_key="secret",
    )
    built = cast(ObjectStoreClient, _FakeObjectStore())
    assert resolve_object_store_client(config, client_factory=lambda _value: built) is built


def test_object_store_client_upload_presign_delete_and_cdn(tmp_path, monkeypatch):
    from podcast_mcp.util.object_store import ObjectStoreClient

    calls: dict[str, object] = {}

    class _FakeBoto:
        def upload_file(self, *args, **kwargs):
            calls["upload"] = (args, kwargs)

        def generate_presigned_url(self, op, Params=None, ExpiresIn=None):
            calls["presign"] = (op, Params, ExpiresIn)
            return "https://example-bucket.s3.example.test/review/a.mp3?X-Amz=1"

        def delete_object(self, **kwargs):
            calls["delete"] = kwargs

    class _FakeBoto3:
        @staticmethod
        def client(*args, **kwargs):
            calls["client_kwargs"] = kwargs
            return _FakeBoto()

    class _FakeConfig:
        def __init__(self, **kwargs):
            calls["config"] = kwargs

    import sys
    import types

    fake_boto3 = types.ModuleType("boto3")
    fake_boto3.client = _FakeBoto3.client  # type: ignore[attr-defined]
    fake_botocore = types.ModuleType("botocore")
    fake_botocore_client = types.ModuleType("botocore.client")
    fake_botocore_client.Config = _FakeConfig  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    monkeypatch.setitem(sys.modules, "botocore", fake_botocore)
    monkeypatch.setitem(sys.modules, "botocore.client", fake_botocore_client)

    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="podcast-review-tmp",
        access_key_id="k",
        secret_access_key="s",
        cdn_endpoint="https://cdn.example",
    )
    client = ObjectStoreClient(cfg)
    assert client.bucket == "podcast-review-tmp"
    local = tmp_path / "mix.mp3"
    local.write_bytes(b"id3")
    client.upload_file(local, "review/v/mix.mp3")
    assert "upload" in calls
    url = client.presigned_get_url("review/v/mix.mp3", expires_in=3600)
    assert url.startswith("https://cdn.example/review/a.mp3")
    assert "X-Amz=1" in url
    client.delete_object("review/v/mix.mp3")
    assert calls["delete"]["Key"] == "review/v/mix.mp3"


def test_object_store_client_requires_boto3(monkeypatch):
    import builtins

    from podcast_mcp.util.object_store import ObjectStoreClient

    real_import = builtins.__import__

    def _deny_boto3(name, *args, **kwargs):
        if name == "boto3" or name.startswith("botocore"):
            raise ImportError("denied")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _deny_boto3)
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    try:
        ObjectStoreClient(cfg)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "boto3" in str(exc)


def test_ensure_version_mp3_encodes_legacy(minimal_project, sample_wav):
    from podcast_mcp.services.review_media import ensure_version_mp3

    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="legacy-encode")
    vid = ver["id"]
    mp3 = Path(ws.project.workspace_dir) / ver["mp3_relpath"]
    mp3.unlink()

    def mutate(p):
        get_version(p, vid).mp3_relpath = None
        return {}

    ws.mutate("before", "after", mutate)
    path = ensure_version_mp3(ws, vid)
    assert path.is_file()
    assert path.suffix == ".mp3"
    assert get_version(ws.project, vid).mp3_relpath


def test_delete_object_store_skips_when_other_share_active(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.review_media import delete_object_store_object_if_unused

    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    fake = _FakeObjectStore()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="test-bucket",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="multi")
    a = ShareService(ws).create(review_version_id=ver["id"])
    b = ShareService(ws).create(review_version_id=ver["id"])
    ShareService(ws).revoke(a["token"])
    assert not fake.deleted
    assert delete_object_store_object_if_unused(ws, ver["id"]) is False
    ShareService(ws).revoke(b["token"])
    assert fake.deleted


def test_presign_ttl_invalid_and_naive():
    assert presign_ttl_seconds("not-a-date") == 24 * 3600
    naive = (datetime.now(UTC) + timedelta(hours=2)).replace(tzinfo=None).isoformat()
    assert 3600 <= presign_ttl_seconds(naive) <= 24 * 3600
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    assert presign_ttl_seconds(past) == 3600


def test_upload_returns_none_without_object_store(minimal_project, sample_wav, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="no-object_store")
    assert upload_review_version_to_object_store(ws, ver["id"]) is None


def test_legacy_version_without_mp3_falls_back_to_wav(minimal_project, sample_wav):
    """Older versions that only have mix.wav still resolve for guests."""
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="legacy")
    vid = ver["id"]
    mp3 = Path(ws.project.workspace_dir) / ver["mp3_relpath"]
    mp3.unlink()

    def mutate(p):
        get_version(p, vid).mp3_relpath = None
        return {}

    ws.mutate("before strip mp3", "after strip mp3", mutate)
    path = review_guest_audio_path(ws.project, vid)
    assert path.suffix == ".wav"


def test_presign_and_delete_client_variants(
    minimal_project, sample_wav, monkeypatch, tmp_workspace
):
    from podcast_mcp.services.review_media import (
        delete_object_store_object_if_unused,
        presigned_review_audio_url,
        upload_review_version_to_object_store,
    )

    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    fake = _FakeObjectStore()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="test-bucket",
        access_key_id="k",
        secret_access_key="s",
    )
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="variants")
    key = upload_review_version_to_object_store(ws, ver["id"], object_store=fake)
    assert key
    url = presigned_review_audio_url(ws.project, ver["id"], object_store=fake)
    assert url
    url2 = presigned_review_audio_url(ws.project, ver["id"], object_store=cfg)
    assert url2
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.review_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    url3 = presigned_review_audio_url(ws.project, ver["id"])
    assert url3
    # Active share blocks delete
    ShareService(ws).create(review_version_id=ver["id"], capabilities=["play"])
    assert delete_object_store_object_if_unused(ws, ver["id"], object_store=fake) is False
