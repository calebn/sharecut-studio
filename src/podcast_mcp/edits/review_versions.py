"""Freeze review mix versions under artifacts/review/{id}/."""

from __future__ import annotations

import logging
import os
import shutil
import stat
import tempfile
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EpisodeProject, ReviewMixVersion
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.workspace_paths import resolve_within

log = logging.getLogger(__name__)

_REVIEW_MP3_BITRATE_KBPS = 128
_STALE_MP3_TEMP_AGE_SECONDS = 24 * 60 * 60
_STALE_MP3_TEMP_CLEANUP_LIMIT = 32
_SAFE_STALE_CLEANUP_SUPPORTED = (
    os.scandir in os.supports_fd
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.unlink in os.supports_dir_fd
    and hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
)
_SAFE_FAILED_CLEANUP_SUPPORTED = (
    _SAFE_STALE_CLEANUP_SUPPORTED
    and os.rename in os.supports_dir_fd
    and os.rmdir in os.supports_dir_fd
    and shutil.rmtree.avoids_symlink_attacks
)
REVIEW_ARTIFACTS_RELDIR = "artifacts/review"

DirectoryIdentity = tuple[int, int]

_QUARANTINE_PREFIX = ".failed-review-"
_QUARANTINE_ENTRY = "media"


def _dir_identity(metadata: os.stat_result) -> DirectoryIdentity:
    """``(st_dev, st_ino)``; valid only while the entry exists (inode numbers can be reused)."""
    return (metadata.st_dev, metadata.st_ino)


def _is_created_dir(metadata: os.stat_result, identity: DirectoryIdentity) -> bool:
    return stat.S_ISDIR(metadata.st_mode) and _dir_identity(metadata) == identity


def _open_pinned_dir(path: str | Path, *, dir_fd: int | None = None) -> int:
    """Open *path* as a no-follow directory descriptor (callers check platform support)."""
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def _created_dir_identity(version_dir: Path) -> DirectoryIdentity:
    """Record the identity of a just-created directory; remove it if the read fails."""
    try:
        return _dir_identity(version_dir.stat(follow_symlinks=False))
    except BaseException:
        try:
            version_dir.rmdir()
        except OSError:
            log.warning("Could not remove review version directory %s", version_dir)
        raise


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def resolve_source_mix(
    project: EpisodeProject,
    *,
    prefer: str = "premix",
) -> tuple[Path, str]:
    """Return (absolute wav path, source label). Prefer premix, else mastered."""
    art = project.artifacts_dir()
    order = [prefer, "mastered", "premix"] if prefer == "mastered" else ["premix", "mastered"]
    seen: set[str] = set()
    for name in order:
        if name in seen:
            continue
        seen.add(name)
        path = art / f"{name}.wav"
        if path.is_file():
            return path.resolve(), name
    raise FileNotFoundError("no premix.wav or mastered.wav; run render-preview / pipeline first")


def list_versions(project: EpisodeProject) -> list[ReviewMixVersion]:
    return list(project.review.versions)


def get_version(project: EpisodeProject, version_id: str) -> ReviewMixVersion:
    for v in project.review.versions:
        if v.id == version_id:
            return v
    raise KeyError(f"review version not found: {version_id}")


def review_artifacts_dir(project: EpisodeProject) -> Path:
    """Root that every frozen review mix must resolve inside (same dir writers use)."""
    return project.workspace_path() / REVIEW_ARTIFACTS_RELDIR


def _resolve_review_media(
    project: EpisodeProject, stored: str, *, version_id: str, field: str
) -> Path:
    """Resolve a persisted review-media relpath; reject escapes from artifacts/review/."""
    try:
        return resolve_within(review_artifacts_dir(project), stored, base=project.workspace_path())
    except ValueError:
        log.warning(
            "Refusing review version %s %s outside %s/", version_id, field, REVIEW_ARTIFACTS_RELDIR
        )
        raise ValueError(
            f"review version {version_id}: {field} must stay under {REVIEW_ARTIFACTS_RELDIR}/"
        ) from None


def version_audio_path(project: EpisodeProject, version_id: str) -> Path:
    """Return the absolute frozen mix.wav; ValueError if it escapes artifacts/review/."""
    ver = get_version(project, version_id)
    path = _resolve_review_media(
        project, ver.audio_relpath, version_id=version_id, field="audio_relpath"
    )
    if not path.is_file():
        raise FileNotFoundError(f"review mix missing: {path}")
    return path


def version_mp3_path(project: EpisodeProject, version_id: str) -> Path | None:
    """Return absolute mix.mp3 path when present on disk; ValueError if it escapes artifacts/review/."""
    ver = get_version(project, version_id)
    if not ver.mp3_relpath:
        return None
    path = _resolve_review_media(
        project, ver.mp3_relpath, version_id=version_id, field="mp3_relpath"
    )
    if not path.is_file():
        return None
    return path


def _clean_stale_mp3_temps(version_dir: Path) -> None:
    """Bound best-effort cleanup to old regular retry files in one pinned version dir."""
    if not _SAFE_STALE_CLEANUP_SUPPORTED:
        log.debug("Skipping stale review MP3 cleanup without descriptor-relative file operations")
        return
    cutoff = time.time() - _STALE_MP3_TEMP_AGE_SECONDS
    inspected = 0
    directory_fd = -1
    try:
        directory_fd = _open_pinned_dir(version_dir.anchor)
        for component in version_dir.parts[1:]:
            child_fd = _open_pinned_dir(component, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child_fd
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                if inspected >= _STALE_MP3_TEMP_CLEANUP_LIMIT:
                    break
                if not (entry.name.startswith(".mix-") and entry.name.endswith(".mp3")):
                    continue
                inspected += 1
                try:
                    metadata = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mtime > cutoff:
                        continue
                    current = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                    if _dir_identity(current) != _dir_identity(metadata):
                        continue
                    os.unlink(entry.name, dir_fd=directory_fd)
                except OSError:
                    log.warning("Could not remove stale review MP3 %s", entry.name, exc_info=True)
    except OSError:
        log.warning("Could not scan review MP3 retries in %s", version_dir, exc_info=True)
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)


def clean_created_version(version_dir: Path, identity: DirectoryIdentity) -> None:
    """Quarantine one exclusively created directory before removing its contents.

    A mismatch before the move leaves the public directory in place. A replacement
    that lands between that check and the rename is moved into the quarantine and
    kept there: it is not restored (that needs a no-replace rename) and not deleted.
    Where descriptor-relative operations exist the root and quarantine are pinned by
    fd; otherwise the same identity-checked quarantine runs on resolved paths.
    A version directory that is already gone counts as nothing to clean.
    """
    pinned = _SAFE_FAILED_CLEANUP_SUPPORTED
    root = version_dir.parent
    root_fd: int | None = None
    quarantine_fd: int | None = None
    quarantine: Path | None = None
    try:
        if pinned:
            root_fd = _open_pinned_dir(root)
        public: str | Path = version_dir.name if pinned else version_dir
        try:
            current = os.stat(public, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            log.debug("Review version directory already removed: %s", version_dir)
            return
        if not _is_created_dir(current, identity):
            log.warning("Review version directory changed; keeping %s", version_dir)
            return
        quarantine = Path(tempfile.mkdtemp(prefix=_QUARANTINE_PREFIX, dir=root))
        if pinned:
            quarantine_fd = _open_pinned_dir(quarantine)
        moved: str | Path = _QUARANTINE_ENTRY if pinned else quarantine / _QUARANTINE_ENTRY
        os.rename(public, moved, src_dir_fd=root_fd, dst_dir_fd=quarantine_fd)
        after = os.stat(moved, dir_fd=quarantine_fd, follow_symlinks=False)
        if not _is_created_dir(after, identity):
            log.warning(
                "Review version directory changed during quarantine; keeping %s", quarantine
            )
            return
        shutil.rmtree(moved, dir_fd=quarantine_fd)
    finally:
        for fd in (quarantine_fd, root_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    log.warning("Could not close review cleanup descriptor %d", fd, exc_info=True)
        if quarantine is not None:
            try:
                quarantine.rmdir()
            except OSError:
                # A changed directory or failed removal stays available for inspection.
                log.warning("Keeping failed review quarantine %s", quarantine)


def encode_version_mp3(
    project: EpisodeProject,
    version_id: str,
    *,
    eng: FFmpegEngine | None = None,
) -> Path:
    """Ensure ``mix.mp3`` exists for *version_id*; update ``mp3_relpath``."""
    ver = get_version(project, version_id)
    existing = version_mp3_path(project, version_id)
    if existing is not None:
        return existing
    wav = version_audio_path(project, version_id)
    review_root = review_artifacts_dir(project)
    resolved_root = review_root.resolve(strict=True)
    if not wav.is_relative_to(resolved_root):
        raise RuntimeError("review artifacts directory changed during MP3 retry")
    mp3_rel = f"{REVIEW_ARTIFACTS_RELDIR}/{version_id}/mix.mp3"
    version_dir = (resolved_root / version_id).resolve()
    if not version_dir.is_relative_to(resolved_root):
        raise ValueError("review version directory must stay under artifacts/review/")
    version_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = version_dir / "mix.mp3"
    engine = eng or FFmpegEngine()
    _clean_stale_mp3_temps(version_dir)
    with tempfile.NamedTemporaryFile(
        prefix=".mix-", suffix=".mp3", dir=version_dir, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        engine.export_mp3(wav, temporary_path, bitrate_kbps=_REVIEW_MP3_BITRATE_KBPS)
        if review_root.resolve(strict=True) != resolved_root:
            raise RuntimeError("review artifacts directory changed during MP3 retry")
        os.replace(temporary_path, mp3_path)
        if review_root.resolve(strict=True) != resolved_root:
            raise RuntimeError("review artifacts directory changed during MP3 retry")
    finally:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            log.warning("Could not remove temporary review MP3 %s", temporary_path, exc_info=True)
    ver.mp3_relpath = mp3_rel
    return mp3_path.resolve()


def publish_version(
    project: EpisodeProject,
    *,
    label: str,
    prefer: str = "premix",
    set_active: bool = True,
    eng: FFmpegEngine | None = None,
    on_media_created: Callable[[Path, DirectoryIdentity], None] | None = None,
) -> ReviewMixVersion:
    """Copy current premix/mastered into artifacts/review/{id}/mix.wav (+ mix.mp3).

    ``on_media_created(version_dir, identity)`` receives the identity recorded once
    at creation so callers clean up the same directory this call made.
    """
    text = (label or "").strip()
    if not text:
        raise ValueError("label is required")
    src, source = resolve_source_mix(project, prefer=prefer)
    vid = _new_id()
    rel = f"{REVIEW_ARTIFACTS_RELDIR}/{vid}/mix.wav"
    review_root = review_artifacts_dir(project)
    review_root.mkdir(parents=True, exist_ok=True)
    resolved_root = review_root.resolve(strict=True)
    version_dir = resolved_root / vid
    version_dir.mkdir(parents=True, exist_ok=False)
    created_identity = _created_dir_identity(version_dir)
    dest = version_dir / "mix.wav"
    mp3_rel = f"{REVIEW_ARTIFACTS_RELDIR}/{vid}/mix.mp3"
    mp3_path = version_dir / "mix.mp3"
    try:
        if on_media_created is not None:
            on_media_created(version_dir, created_identity)
        shutil.copy2(src, dest)
        engine = eng or FFmpegEngine()
        engine.export_mp3(dest, mp3_path, bitrate_kbps=_REVIEW_MP3_BITRATE_KBPS)
        ver = ReviewMixVersion(
            id=vid,
            label=text,
            created_at=_now_iso(),
            audio_relpath=rel,
            sha256=sha256_file(dest),
            source=source,
            mp3_relpath=mp3_rel,
        )
        if review_root.resolve(strict=True) != resolved_root:
            raise RuntimeError("review artifacts directory changed during publication")
    except BaseException:
        try:
            clean_created_version(version_dir, created_identity)
        except BaseException:
            # Same contract as ReviewService._clean_uncommitted_media: never mask the original error.
            log.warning(
                "Could not remove failed review version directory %s", version_dir, exc_info=True
            )
        raise
    project.review.versions.append(ver)
    if set_active:
        project.review.active_version_id = vid
    return ver


def set_active_version(
    project: EpisodeProject,
    version_id: str | None,
) -> str | None:
    if version_id is None or version_id == "":
        project.review.active_version_id = None
        return None
    get_version(project, version_id)
    project.review.active_version_id = version_id
    return version_id
