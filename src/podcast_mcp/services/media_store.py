"""Store uploaded source audio under episode ``raw/`` (shared host + guest)."""

from __future__ import annotations

import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.util.body_limits import env_max_bytes

ALLOWED_AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".m4a", ".flac", ".aiff", ".aif", ".ogg"})

_SAFE_NAME = re.compile(r"[^a-zA-Z0-9._-]+")

_DEFAULT_MEDIA_MAX = 512 * 1024 * 1024
_DEFAULT_CHUNK_MAX = 4 * 1024 * 1024
_MAX_TOTAL_CHUNKS = 128
_UPLOAD_TTL_SEC = 3600
_PENDING_UPLOAD_QUOTA = 2 * 512 * 1024 * 1024  # 2x media max across incomplete uploads


def gui_media_max_bytes() -> int:
    return env_max_bytes("PODCAST_GUI_MEDIA_MAX_BYTES", _DEFAULT_MEDIA_MAX)


def gui_media_chunk_max_bytes() -> int:
    return env_max_bytes("PODCAST_GUI_MEDIA_CHUNK_MAX_BYTES", _DEFAULT_CHUNK_MAX)


def max_upload_chunks() -> int:
    chunk = gui_media_chunk_max_bytes()
    by_size = max(1, (gui_media_max_bytes() + chunk - 1) // chunk)
    return min(_MAX_TOTAL_CHUNKS, by_size)


def safe_audio_filename(name: str) -> str:
    base = Path(name).name
    cleaned = _SAFE_NAME.sub("_", base).strip("._") or "audio"
    suffix = Path(cleaned).suffix.lower()
    if suffix not in ALLOWED_AUDIO_EXTENSIONS:
        raise ValueError(
            f"unsupported audio type {suffix!r}; "
            f"allowed: {', '.join(sorted(ALLOWED_AUDIO_EXTENSIONS))}"
        )
    stem = Path(cleaned).stem[:80] or "audio"
    return f"{stem}{suffix}"


def unique_raw_path(workspace_dir: Path, filename: str) -> Path:
    raw = workspace_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    safe = safe_audio_filename(filename)
    dest = raw / safe
    if not dest.exists():
        return dest
    stem = dest.stem
    suffix = dest.suffix
    i = 2
    while True:
        candidate = raw / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def uploads_dir(workspace_dir: Path) -> Path:
    d = workspace_dir / "artifacts" / ".uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def sweep_stale_uploads(workspace_dir: Path, *, ttl_sec: int = _UPLOAD_TTL_SEC) -> int:
    """Remove incomplete upload dirs older than *ttl_sec*. Returns count removed."""
    root = workspace_dir / "artifacts" / ".uploads"
    if not root.is_dir():
        return 0
    now = time.time()
    removed = 0
    for part_dir in list(root.iterdir()):
        try:
            if not part_dir.is_dir():
                continue
            mtime = part_dir.stat().st_mtime
        except OSError:
            continue
        if now - mtime > ttl_sec:
            shutil.rmtree(part_dir, ignore_errors=True)
            removed += 1
    return removed


def pending_upload_bytes(workspace_dir: Path) -> int:
    root = workspace_dir / "artifacts" / ".uploads"
    if not root.is_dir():
        return 0
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


def write_complete_upload(
    workspace_dir: Path,
    *,
    filename: str,
    data: bytes,
) -> dict[str, Any]:
    """Write a complete audio payload into ``raw/`` and verify ffprobe succeeds."""
    limit = gui_media_max_bytes()
    if len(data) > limit:
        raise ValueError(f"upload exceeds {limit} bytes")
    if not data:
        raise ValueError("empty upload")
    dest = unique_raw_path(workspace_dir, filename)
    dest.write_bytes(data)
    return _finalize_upload(workspace_dir, dest)


def write_complete_upload_from_parts(
    workspace_dir: Path,
    *,
    filename: str,
    part_paths: list[Path],
) -> dict[str, Any]:
    """Stream chunk part files into ``raw/`` without loading the full assemble into RAM."""
    if not part_paths:
        raise ValueError("empty upload")
    limit = gui_media_max_bytes()
    total = sum(p.stat().st_size for p in part_paths)
    if total > limit:
        raise ValueError(f"upload exceeds {limit} bytes")
    if total <= 0:
        raise ValueError("empty upload")
    dest = unique_raw_path(workspace_dir, filename)
    try:
        with dest.open("wb") as out:
            for part in part_paths:
                with part.open("rb") as src:
                    shutil.copyfileobj(src, out, length=1024 * 1024)
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    return _finalize_upload(workspace_dir, dest)


def _finalize_upload(workspace_dir: Path, dest: Path) -> dict[str, Any]:
    try:
        probe = FFmpegEngine().probe(dest, untrusted=True)
        if not probe.duration_sec or probe.duration_sec <= 0:
            raise ValueError("ffprobe returned zero duration")
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    rel = str(dest.relative_to(workspace_dir.resolve()))
    return {
        "rel_path": rel,
        "filename": dest.name,
        "bytes": dest.stat().st_size,
        "duration_sec": float(probe.duration_sec),
    }


def write_upload_chunk(
    workspace_dir: Path,
    *,
    filename: str,
    data: bytes,
    upload_id: str | None,
    chunk_index: int,
    total_chunks: int,
) -> dict[str, Any]:
    """Append/assemble chunked upload; returns ``complete`` when all chunks arrived."""
    sweep_stale_uploads(workspace_dir)
    chunk_limit = gui_media_chunk_max_bytes()
    if len(data) > chunk_limit:
        raise ValueError(f"chunk exceeds {chunk_limit} bytes")
    if total_chunks < 1:
        raise ValueError("total_chunks must be >= 1")
    max_chunks = max_upload_chunks()
    if total_chunks > max_chunks:
        raise ValueError(f"total_chunks exceeds max {max_chunks}")
    if chunk_index < 0 or chunk_index >= total_chunks:
        raise ValueError("chunk_index out of range")
    if total_chunks == 1:
        out = write_complete_upload(workspace_dir, filename=filename, data=data)
        return {**out, "complete": True, "upload_id": upload_id or ""}

    if pending_upload_bytes(workspace_dir) + len(data) > _PENDING_UPLOAD_QUOTA:
        raise ValueError("pending upload quota exceeded; retry after incomplete uploads expire")

    uid = (upload_id or "").strip() or uuid.uuid4().hex
    if not re.fullmatch(r"[a-fA-F0-9_-]{8,64}", uid):
        raise ValueError("invalid upload_id")
    part_dir = uploads_dir(workspace_dir) / uid
    part_dir.mkdir(parents=True, exist_ok=True)
    meta = part_dir / "meta.txt"
    if not meta.exists():
        meta.write_text(f"{safe_audio_filename(filename)}\n{total_chunks}\n", encoding="utf-8")
    else:
        lines = meta.read_text(encoding="utf-8").splitlines()
        if len(lines) >= 2 and int(lines[1]) != total_chunks:
            raise ValueError("total_chunks mismatch for upload_id")
    part_path = part_dir / f"chunk_{chunk_index:05d}"
    if part_path.exists():
        raise ValueError("duplicate chunk_index")
    part_path.write_bytes(data)

    expected = [part_dir / f"chunk_{i:05d}" for i in range(total_chunks)]
    received = [p for p in expected if p.is_file()]
    assembled_bytes = sum(p.stat().st_size for p in received)
    limit = gui_media_max_bytes()
    if assembled_bytes > limit:
        for p in part_dir.iterdir():
            p.unlink(missing_ok=True)
        part_dir.rmdir()
        raise ValueError(f"upload exceeds {limit} bytes")
    if len(received) < total_chunks:
        return {
            "complete": False,
            "upload_id": uid,
            "chunks_received": len(received),
            "total_chunks": total_chunks,
            "bytes": len(data),
        }

    lines = meta.read_text(encoding="utf-8").splitlines()
    final_name = lines[0] if lines else safe_audio_filename(filename)
    try:
        out = write_complete_upload_from_parts(
            workspace_dir,
            filename=final_name,
            part_paths=expected,
        )
    finally:
        for p in part_dir.iterdir():
            p.unlink(missing_ok=True)
        part_dir.rmdir()
    return {**out, "complete": True, "upload_id": uid}
