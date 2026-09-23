"""Host proxy media: FX source-clock chunks + object storage upload."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from podcast_mcp.engines.play_audit import proxy_render_hash
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.proxy_media import (
    _purge_stale_proxy_dirs,
    chunk_count_for,
    chunk_window,
    delete_all_proxies_if_unused,
    delete_proxy_objects_if_unused,
    ensure_and_upload_all_proxies,
    ensure_track_proxy,
    local_proxy_chunk_path,
    presigned_proxy_urls,
    proxy_chunk_key,
    proxy_dir,
    proxy_object_prefix,
    upload_track_proxy_to_object_store,
)
from podcast_mcp.util.object_store import ObjectStoreConfig


def _seed_track(minimal_project) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    if not any(t.id == "host" for t in proj.tracks):
        proj.tracks.append(
            Track(
                id="host",
                label="Host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
            )
        )
        save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_chunk_window_math():
    start0, dur0 = chunk_window(0, 125.0, chunk_sec=60.0, overlap_ms=200)
    assert start0 == 0.0
    assert dur0 == pytest.approx(60.2)
    start1, dur1 = chunk_window(1, 125.0, chunk_sec=60.0, overlap_ms=200)
    assert start1 == pytest.approx(59.8)
    assert dur1 == pytest.approx(60.4)
    start2, dur2 = chunk_window(2, 125.0, chunk_sec=60.0, overlap_ms=200)
    assert start2 == pytest.approx(119.8)
    assert start2 + dur2 == pytest.approx(125.0)


def test_chunk_count_for():
    assert chunk_count_for(0.0) == 1
    assert chunk_count_for(30.0) == 1
    assert chunk_count_for(60.0) == 1
    assert chunk_count_for(60.1) == 2
    assert chunk_count_for(125.0) == 3


def test_proxy_render_hash_stable_across_edits(minimal_project):
    ws = _seed_track(minimal_project)
    track_id = "host"
    h1 = proxy_render_hash(ws.project, track_id)

    def mutate(p):
        p.edit_decisions.append(
            EditDecision(
                id="e1",
                type=EditDecisionType.REMOVE,
                start=0.1,
                end=0.2,
                track_id=track_id,
                applied=True,
            )
        )
        return {}

    ws.mutate("before", "after", mutate)
    assert proxy_render_hash(ws.project, track_id) == h1


def test_proxy_render_hash_changes_with_chain(minimal_project):
    ws = _seed_track(minimal_project)
    track_id = "host"
    h1 = proxy_render_hash(ws.project, track_id)

    def mutate(p):
        p.processing_chains.append(
            ProcessingChain(
                track_id=track_id,
                effects=[
                    ProcessingEffect(effect="highpass", params={"frequency": 100}, bypass=False)
                ],
            )
        )
        return {}

    ws.mutate("before chain", "after chain", mutate)
    assert proxy_render_hash(ws.project, track_id) != h1


def test_ensure_track_proxy_creates_chunks(minimal_project, monkeypatch):
    import podcast_mcp.services.proxy_media as pm

    monkeypatch.setattr(pm, "CHUNK_SEC", 0.5)
    ws = _seed_track(minimal_project)
    track_id = "host"
    proxy = ensure_track_proxy(ws, track_id)
    assert proxy.chunk_count >= 1
    out = proxy_dir(ws, track_id, proxy.hash)
    files = sorted(out.glob("*.mp3"))
    assert len(files) == proxy.chunk_count
    again = ensure_track_proxy(ws, track_id)
    assert again.hash == proxy.hash
    assert local_proxy_chunk_path(ws, track_id, 0).is_file()


def test_upload_and_presign_proxy(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    track_id = "host"
    fake = MagicMock()
    fake.upload_file = MagicMock()
    fake.presigned_get_url = MagicMock(
        side_effect=lambda key, expires_in: f"https://cdn.test/{key}?e={expires_in}"
    )
    fake.delete_object = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    prefix = upload_track_proxy_to_object_store(ws, track_id, object_store=cfg)
    assert prefix == proxy_object_prefix(track_id, ws.project.track_by_id(track_id).proxy.hash)
    assert fake.upload_file.called
    urls = presigned_proxy_urls(ws.project, track_id, object_store=cfg)
    assert urls is not None
    assert len(urls) == ws.project.track_by_id(track_id).proxy.chunk_count
    fake.upload_file.reset_mock()
    upload_track_proxy_to_object_store(ws, track_id, object_store=cfg)
    assert not fake.upload_file.called


def test_delete_proxy_when_no_shares(minimal_project, monkeypatch, tmp_workspace):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_track(minimal_project)
    track_id = "host"
    fake = MagicMock()
    fake.upload_file = MagicMock()
    fake.presigned_get_url = MagicMock(return_value="https://x")
    fake.delete_object = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    upload_track_proxy_to_object_store(ws, track_id, object_store=cfg)
    assert delete_proxy_objects_if_unused(ws, track_id, object_store=cfg) is True
    assert fake.delete_object.called
    t = ws.project.track_by_id(track_id)
    assert t.proxy.object_store_prefix is None


def test_proxy_chunk_key_format():
    assert proxy_chunk_key("host", "abc123", 3) == "proxy/host/abc123/00003.mp3"


def test_purge_stale_and_missing_paths(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    proxy = ensure_track_proxy(ws, "host")
    stale = proxy_dir(ws, "host", "oldhash")
    stale.mkdir(parents=True)
    (stale / "00000.mp3").write_bytes(b"x")
    _purge_stale_proxy_dirs(ws, "host", proxy.hash)
    assert not stale.exists()
    _purge_stale_proxy_dirs(ws, "missing-track", "x")


def test_upload_no_object_store_config(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    assert upload_track_proxy_to_object_store(ws, "host") is None
    assert presigned_proxy_urls(ws.project, "host") is None


def test_presign_requires_prefix(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    ensure_track_proxy(ws, "host")
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    assert presigned_proxy_urls(ws.project, "host", object_store=cfg) is None


def test_presign_no_client_after_prefix(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    ensure_track_proxy(ws, "host")

    def mutate(p):
        t = p.track_by_id("host")
        assert t and t.proxy
        t.proxy.object_store_prefix = "proxy/host/h/"
        t.proxy.object_store_uploaded_at = "2020-01-01T00:00:00+00:00"
        return {}

    ws.mutate("before", "after", mutate)
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    assert presigned_proxy_urls(ws.project, "host") is None


def test_upload_missing_chunk_raises(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    proxy = ensure_track_proxy(ws, "host")
    out = proxy_dir(ws, "host", proxy.hash)
    for f in out.glob("*.mp3"):
        f.unlink()
    # Avoid re-render; exercise the missing-file branch inside upload.
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ensure_track_proxy",
        lambda _ws, _tid: proxy,
    )
    fake = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    with pytest.raises(FileNotFoundError, match="missing proxy chunk"):
        upload_track_proxy_to_object_store(ws, "host", object_store=cfg)


def test_delete_skips_when_active_share(minimal_project, monkeypatch, tmp_workspace, sample_wav):
    from podcast_mcp.services import ReviewService
    from podcast_mcp.services.share import ShareService

    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    ws = _seed_track(minimal_project)
    art = ws.project.artifacts_dir()
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    ver = ReviewService(ws).publish(label="Proxy")
    ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["view", "play"],
    )
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    ensure_track_proxy(ws, "host")

    def mutate(p):
        t = p.track_by_id("host")
        assert t and t.proxy
        t.proxy.object_store_prefix = "proxy/host/h/"
        t.proxy.object_store_uploaded_at = "2020-01-01T00:00:00+00:00"
        return {}

    ws.mutate("before", "after", mutate)
    fake = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    assert delete_proxy_objects_if_unused(ws, "host", object_store=cfg) is False
    assert not fake.delete_object.called


def test_delete_no_prefix_or_client(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    ensure_track_proxy(ws, "host")
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    assert delete_proxy_objects_if_unused(ws, "host", object_store=cfg) is False

    def mutate(p):
        t = p.track_by_id("host")
        assert t and t.proxy
        t.proxy.object_store_prefix = "proxy/host/h/"
        t.proxy.object_store_uploaded_at = "2020-01-01T00:00:00+00:00"
        return {}

    ws.mutate("before", "after", mutate)
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: None,
    )
    assert delete_proxy_objects_if_unused(ws, "host") is False


def test_delete_object_failure(minimal_project, monkeypatch, tmp_workspace):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    ensure_track_proxy(ws, "host")

    def mutate(p):
        t = p.track_by_id("host")
        assert t and t.proxy
        t.proxy.object_store_prefix = "proxy/host/h/"
        t.proxy.object_store_uploaded_at = "2020-01-01T00:00:00+00:00"
        return {}

    ws.mutate("before", "after", mutate)
    fake = MagicMock()
    fake.delete_object = MagicMock(side_effect=RuntimeError("boom"))
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    assert delete_proxy_objects_if_unused(ws, "host", object_store=cfg) is False


def test_ensure_and_upload_all_and_delete_all(minimal_project, monkeypatch, tmp_workspace):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    fake = MagicMock()
    fake.upload_file = MagicMock()
    fake.delete_object = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.load_object_store_config",
        lambda config_path=None: cfg,
    )
    ensure_and_upload_all_proxies(ws)
    assert ws.project.track_by_id("host").proxy is not None
    assert fake.upload_file.called
    delete_all_proxies_if_unused(ws)
    assert fake.delete_object.called


def test_ensure_upload_all_swallows_errors(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ensure_track_proxy",
        MagicMock(side_effect=RuntimeError("nope")),
    )
    ensure_and_upload_all_proxies(ws)
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.delete_proxy_objects_if_unused",
        MagicMock(side_effect=RuntimeError("nope")),
    )
    delete_all_proxies_if_unused(ws)


def test_local_proxy_chunk_path_errors(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    with pytest.raises(KeyError, match="proxy not available"):
        local_proxy_chunk_path(ws, "host", 0)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    proxy = ensure_track_proxy(ws, "host")
    with pytest.raises(KeyError, match="chunk not found"):
        local_proxy_chunk_path(ws, "host", proxy.chunk_count + 5)
    path = local_proxy_chunk_path(ws, "host", 0)
    path.unlink()
    with pytest.raises(FileNotFoundError, match="chunk not found"):
        local_proxy_chunk_path(ws, "host", 0)


def test_delete_mutate_failure_still_returns_true(minimal_project, monkeypatch, tmp_workspace):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(index))
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    ensure_track_proxy(ws, "host")

    def mutate(p):
        t = p.track_by_id("host")
        assert t and t.proxy
        t.proxy.object_store_prefix = "proxy/host/h/"
        t.proxy.object_store_uploaded_at = "2020-01-01T00:00:00+00:00"
        return {}

    ws.mutate("before", "after", mutate)
    fake = MagicMock()
    fake.delete_object = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    monkeypatch.setattr(
        ws,
        "mutate",
        MagicMock(side_effect=RuntimeError("mutate fail")),
    )
    assert delete_proxy_objects_if_unused(ws, "host", object_store=cfg) is True
    assert fake.delete_object.called


def test_object_store_client_from_config_object(minimal_project, monkeypatch):
    ws = _seed_track(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.proxy_media.CHUNK_SEC", 0.5)
    fake = MagicMock()
    fake.upload_file = MagicMock()
    cfg = ObjectStoreConfig(
        endpoint_url="https://s3.example.test",
        region="us-test-1",
        bucket="b",
        access_key_id="k",
        secret_access_key="s",
    )
    monkeypatch.setattr(
        "podcast_mcp.services.proxy_media.ObjectStoreClient",
        lambda _cfg: fake,
    )
    prefix = upload_track_proxy_to_object_store(ws, "host", object_store=cfg)
    assert prefix is not None
    # Pass an already-constructed ObjectStoreClient
    fake2 = MagicMock()
    fake2.upload_file = MagicMock()
    # Already uploaded - short-circuit
    assert upload_track_proxy_to_object_store(ws, "host", object_store=fake2) is not None
    assert not fake2.upload_file.called
