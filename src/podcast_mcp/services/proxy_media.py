"""Guest proxy media: FX source-clock chunks + optional object storage upload / presign."""

from __future__ import annotations

import logging
import math
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_shares import list_shares
from podcast_mcp.edits.share_capabilities import CAP_PLAY, CAP_VIEW, has_capability
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import proxy_render_hash
from podcast_mcp.engines.timeline_render import render_source_with_chain
from podcast_mcp.models import EpisodeProject, TrackProxy
from podcast_mcp.services.review_media import presign_ttl_seconds
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.object_store import (
    ObjectStoreClient,
    ObjectStoreConfig,
    load_object_store_config,
    resolve_object_store_client,
)
from podcast_mcp.util.process import run
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)

CHUNK_SEC = 60.0
OVERLAP_MS = 200
PROXY_BITRATE_KBPS = 64


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def proxy_object_prefix(track_id: str, hash_: str) -> str:
    return f"proxy/{track_id}/{hash_}/"


def proxy_chunk_key(track_id: str, hash_: str, idx: int) -> str:
    return f"{proxy_object_prefix(track_id, hash_)}{idx:05d}.mp3"


def proxy_dir(ws: ProjectWorkspace, track_id: str, hash_: str) -> Path:
    return ws.project.artifacts_dir() / "proxy" / track_id / hash_


def chunk_window(
    idx: int,
    duration_sec: float,
    *,
    chunk_sec: float = CHUNK_SEC,
    overlap_ms: int = OVERLAP_MS,
) -> tuple[float, float]:
    """Return (start_sec, dur_sec) for chunk *idx* including overlap."""
    overlap = overlap_ms / 1000.0
    nominal_start = idx * chunk_sec
    start = max(0.0, nominal_start - (0.0 if idx == 0 else overlap))
    end = min(duration_sec, nominal_start + chunk_sec + overlap)
    return start, max(0.01, end - start)


def chunk_count_for(duration_sec: float, *, chunk_sec: float = CHUNK_SEC) -> int:
    if duration_sec <= 0:
        return 1
    return max(1, math.ceil(duration_sec / chunk_sec))


def _encode_chunk(
    eng: FFmpegEngine,
    wav_path: Path,
    out_path: Path,
    start_sec: float,
    dur_sec: float,
    *,
    bitrate_kbps: int = PROXY_BITRATE_KBPS,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        eng.ffmpeg,
        "-y",
        "-ss",
        str(max(0.0, start_sec)),
        "-t",
        str(dur_sec),
        "-i",
        str(wav_path),
        "-ac",
        "1",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        f"{bitrate_kbps}k",
        str(out_path),
    ]
    run(cmd, check=True, capture_output=True)


def _purge_stale_proxy_dirs(ws: ProjectWorkspace, track_id: str, keep_hash: str) -> None:
    root = ws.project.artifacts_dir() / "proxy" / track_id
    if not root.is_dir():
        return
    for child in root.iterdir():
        if child.is_dir() and child.name != keep_hash:
            shutil.rmtree(child, ignore_errors=True)


def ensure_track_proxy(ws: ProjectWorkspace, track_id: str) -> TrackProxy:
    """Render FX source-clock WAV and encode overlapping MP3 chunks if needed."""
    track = ws.project.track_by_id(track_id)
    if track is None:
        raise KeyError(f"track not found: {track_id}")
    hash_ = proxy_render_hash(ws.project, track_id)
    out_dir = proxy_dir(ws, track_id, hash_)
    if (
        track.proxy is not None
        and track.proxy.hash == hash_
        and out_dir.is_dir()
        and any(out_dir.glob("*.mp3"))
    ):
        return track.proxy

    eng = FFmpegEngine()
    with tempfile.TemporaryDirectory(prefix="proxy_") as tmp:
        wav = Path(tmp) / f"{track_id}.wav"
        render_source_with_chain(ws.project, track, wav, engine=eng)
        duration = float(eng.probe(wav).duration_sec)
        count = chunk_count_for(duration, chunk_sec=CHUNK_SEC)
        out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(count):
            start, dur = chunk_window(i, duration, chunk_sec=CHUNK_SEC, overlap_ms=OVERLAP_MS)
            _encode_chunk(eng, wav, out_dir / f"{i:05d}.mp3", start, dur)

    proxy = TrackProxy(
        hash=hash_,
        chunk_sec=CHUNK_SEC,
        overlap_ms=OVERLAP_MS,
        chunk_count=count,
        duration_sec=duration,
        codec="mp3",
        bitrate_kbps=PROXY_BITRATE_KBPS,
        object_store_prefix=(
            track.proxy.object_store_prefix if track.proxy and track.proxy.hash == hash_ else None
        ),
        object_store_uploaded_at=(
            track.proxy.object_store_uploaded_at
            if track.proxy and track.proxy.hash == hash_
            else None
        ),
    )

    def mutate(p: EpisodeProject) -> dict[str, Any]:
        t = p.track_by_id(track_id)
        if t is None:
            raise KeyError(f"track not found: {track_id}")
        t.proxy = proxy
        return {"hash": hash_, "chunk_count": count}

    ws.mutate("before ensure track proxy", "after ensure track proxy", mutate)
    _purge_stale_proxy_dirs(ws, track_id, hash_)
    refreshed = ws.project.track_by_id(track_id)
    assert refreshed is not None and refreshed.proxy is not None
    return refreshed.proxy


def _object_store_client(
    object_store: ObjectStoreConfig | ObjectStoreClient | None,
) -> ObjectStoreClient | None:
    return resolve_object_store_client(
        object_store,
        config_loader=load_object_store_config,
        client_factory=ObjectStoreClient,
    )


def upload_track_proxy_to_object_store(
    ws: ProjectWorkspace,
    track_id: str,
    *,
    object_store: ObjectStoreConfig | ObjectStoreClient | None = None,
) -> str | None:
    """Upload proxy chunks to object storage when configured; persist prefix on the track."""
    client = _object_store_client(object_store)
    if client is None:
        return None
    proxy = ensure_track_proxy(ws, track_id)
    if proxy.object_store_prefix and proxy.object_store_uploaded_at:
        return proxy.object_store_prefix

    prefix = proxy_object_prefix(track_id, proxy.hash)
    out_dir = proxy_dir(ws, track_id, proxy.hash)
    for i in range(proxy.chunk_count):
        path = out_dir / f"{i:05d}.mp3"
        if not path.is_file():
            raise FileNotFoundError(f"missing proxy chunk: {path}")
        client.upload_file(path, proxy_chunk_key(track_id, proxy.hash, i))
    uploaded_at = _now_iso()

    def mutate(p: EpisodeProject) -> dict[str, Any]:
        t = p.track_by_id(track_id)
        if t is None or t.proxy is None:
            raise KeyError(f"track proxy missing: {track_id}")
        t.proxy.object_store_prefix = prefix
        t.proxy.object_store_uploaded_at = uploaded_at
        return {"object_store_prefix": prefix}

    ws.mutate(
        "before object store upload track proxy", "after object store upload track proxy", mutate
    )
    return prefix


def presigned_proxy_urls(
    project: EpisodeProject,
    track_id: str,
    *,
    expires_at: str | None = None,
    object_store: ObjectStoreConfig | ObjectStoreClient | None = None,
) -> list[str] | None:
    """Return per-chunk presigned GET URLs when object storage upload is recorded."""
    track = project.track_by_id(track_id)
    if track is None or track.proxy is None or not track.proxy.object_store_prefix:
        return None
    client = _object_store_client(object_store)
    if client is None:
        return None
    ttl = presign_ttl_seconds(expires_at)
    proxy = track.proxy
    return [
        client.presigned_get_url(proxy_chunk_key(track_id, proxy.hash, i), expires_in=ttl)
        for i in range(proxy.chunk_count)
    ]


def delete_proxy_objects_if_unused(
    ws: ProjectWorkspace,
    track_id: str,
    *,
    object_store: ObjectStoreConfig | ObjectStoreClient | None = None,
) -> bool:
    """Best-effort delete object storage proxy objects when no active view/play shares remain."""
    track = ws.project.track_by_id(track_id)
    if track is None or track.proxy is None or not track.proxy.object_store_prefix:
        return False
    active = [
        row
        for row in list_shares(ws.project)
        if not row.get("revoked")
        and (
            has_capability(row.get("capabilities"), CAP_VIEW)
            or has_capability(row.get("capabilities"), CAP_PLAY)
        )
    ]
    if active:
        return False

    client = _object_store_client(object_store)
    if client is None:
        return False

    proxy = track.proxy
    for i in range(proxy.chunk_count):
        key = proxy_chunk_key(track_id, proxy.hash, i)
        try:
            client.delete_object(key)
        except Exception:
            log.warning("Failed to delete object storage proxy object %s", key, exc_info=True)
            return False

    def mutate(p: EpisodeProject) -> dict[str, Any]:
        t = p.track_by_id(track_id)
        if t is not None and t.proxy is not None:
            t.proxy.object_store_prefix = None
            t.proxy.object_store_uploaded_at = None
        return {"cleared": True}

    try:
        ws.mutate(
            "before clear object store proxy keys",
            "after clear object store proxy keys",
            mutate,
        )
    except Exception:
        log.warning("Cleared object storage proxy but failed to update project", exc_info=True)
    return True


def ensure_and_upload_all_proxies(ws: ProjectWorkspace) -> None:
    """Best-effort ensure+upload proxies for every dialogue track."""
    for tid in dialogue_track_ids(ws.project):
        try:
            ensure_track_proxy(ws, tid)
            upload_track_proxy_to_object_store(ws, tid)
        except Exception:
            log.warning("Proxy ensure/upload failed for track %s", tid, exc_info=True)


def delete_all_proxies_if_unused(ws: ProjectWorkspace) -> None:
    for tid in dialogue_track_ids(ws.project):
        try:
            delete_proxy_objects_if_unused(ws, tid)
        except Exception:
            log.warning("Proxy object storage cleanup failed for track %s", tid, exc_info=True)


def local_proxy_chunk_path(
    ws: ProjectWorkspace,
    track_id: str,
    chunk_idx: int,
    *,
    expected_hash: str | None = None,
) -> Path:
    track = ws.project.track_by_id(track_id)
    if track is None or track.proxy is None:
        raise KeyError("proxy not available")
    if expected_hash is not None and track.proxy.hash != expected_hash:
        raise KeyError("proxy hash mismatch")
    if chunk_idx < 0 or chunk_idx >= track.proxy.chunk_count:
        raise KeyError("chunk not found")
    path = proxy_dir(ws, track_id, track.proxy.hash) / f"{chunk_idx:05d}.mp3"
    if not path.is_file():
        raise FileNotFoundError("chunk not found")
    return path
