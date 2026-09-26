"""Freeze review mix versions under artifacts/review/{id}/."""

from __future__ import annotations

import ctypes
import errno
import json
import logging
import os
import shutil
import stat
import sys
import tempfile
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import (
    mastered_is_fresh,
    mastered_path,
    premix_is_stale,
    premix_path,
    read_mastered_hash,
)
from podcast_mcp.models import EpisodeProject, ReviewMixVersion, load_project
from podcast_mcp.util.datetime_utils import now_iso as _now_iso
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.project_state import project_commit_lock
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
    and os.mkdir in os.supports_dir_fd
    and os.rmdir in os.supports_dir_fd
    and shutil.rmtree.avoids_symlink_attacks
)
REVIEW_ARTIFACTS_RELDIR = "artifacts/review"

DirectoryIdentity = tuple[int, int]

_QUARANTINE_PREFIX = ".failed-review-"
_QUARANTINE_ENTRY = "media"
_STAGING_PREFIX = ".staging-review-"
_CLEANUP_MARKER = ".failed-review-owner"
_STALE_QUARANTINE_AGE_SECONDS = 24 * 60 * 60
_STALE_QUARANTINE_LIMIT = 32


def _dir_identity(metadata: os.stat_result) -> DirectoryIdentity:
    """``(st_dev, st_ino)``; valid only while the entry exists (inode numbers can be reused)."""
    return (metadata.st_dev, metadata.st_ino)


def _is_created_dir(metadata: os.stat_result, identity: DirectoryIdentity) -> bool:
    return stat.S_ISDIR(metadata.st_mode) and _dir_identity(metadata) == identity


def _open_pinned_dir(path: str | Path, *, dir_fd: int | None = None) -> int:
    """Open *path* as a no-follow directory descriptor (callers check platform support)."""
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def _created_dir_identity(version_dir: Path) -> DirectoryIdentity:
    """Record the identity through a pinned descriptor before media is written."""
    root_fd = _open_pinned_dir(version_dir.parent)
    try:
        staging_fd = _open_pinned_dir(version_dir.name, dir_fd=root_fd)
        try:
            identity = _dir_identity(os.fstat(staging_fd))
            current = os.stat(version_dir.name, dir_fd=root_fd, follow_symlinks=False)
            if not _is_created_dir(current, identity):
                raise RuntimeError("review staging directory changed during identity read")
            return identity
        finally:
            os.close(staging_fd)
    finally:
        os.close(root_fd)


def _rename_noreplace(src: str, dst: str, root_fd: int) -> None:
    """Atomically promote or restore a directory without replacing its destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        operation = getattr(libc, "renameat2", None)
        if operation is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
        result = operation(root_fd, os.fsencode(src), root_fd, os.fsencode(dst), 1)
    elif sys.platform == "darwin":
        operation = getattr(libc, "renameatx_np", None)
        if operation is None:
            raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
        result = operation(root_fd, os.fsencode(src), root_fd, os.fsencode(dst), 4)
    else:
        raise OSError(errno.ENOTSUP, "atomic no-replace rename is unavailable")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), dst)


def promote_staged_version(staging_dir: Path, identity: DirectoryIdentity, version_id: str) -> Path:
    """Publish complete media with one no-replace rename under the caller's commit lock."""
    if not _SAFE_FAILED_CLEANUP_SUPPORTED:
        raise OSError(errno.ENOTSUP, "safe review publication requires directory descriptors")
    root_fd = _open_pinned_dir(staging_dir.parent)
    try:
        current = os.stat(staging_dir.name, dir_fd=root_fd, follow_symlinks=False)
        if not _is_created_dir(current, identity):
            raise RuntimeError("review staging directory changed before publication")
        _rename_noreplace(staging_dir.name, version_id, root_fd)
        return staging_dir.with_name(version_id)
    finally:
        os.close(root_fd)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def resolve_source_mix(
    project: EpisodeProject,
    *,
    prefer: str = "premix",
) -> tuple[Path, str]:
    """Return (absolute wav path, source label). Prefer premix, else mastered.

    Refuses a premix that's behind the project (a volume, mute or edit since the
    last Refresh) and a master that wasn't mastered from the current premix, so a
    review version never freezes an outdated mix. While ``premix.wav`` exists, a
    master with no ``mastered.hash`` (mastered before it existed) or whose premix
    was re-mixed, copied or restored since is refused until export re-masters it.
    With no premix (an imported or legacy episode that only has ``mastered.wav``)
    there is nothing to compare against, so that master publishes as-is.
    """
    if premix_is_stale(project):
        raise ValueError(
            "premix.wav is out of date (edits, volume or mute changed since the last "
            "Refresh), and so is any master built from it; Refresh (render-preview) "
            "before publishing a review version, then export for a mastered one"
        )
    paths = {"premix": premix_path(project), "mastered": mastered_path(project)}
    order = [prefer, "mastered", "premix"] if prefer == "mastered" else ["premix", "mastered"]
    seen: set[str] = set()
    for name in order:
        if name in seen:
            continue
        seen.add(name)
        path = paths[name]
        if not path.is_file():
            continue
        if name == "mastered" and paths["premix"].is_file() and not mastered_is_fresh(project):
            if read_mastered_hash(project) is None:
                raise ValueError(
                    "mastered.wav has no record of the premix it was mastered from "
                    "(mastered before that was tracked, or its last master failed); "
                    "export (or re-run master_loudness) to re-master it, or publish the premix"
                )
            raise ValueError(
                "mastered.wav wasn't mastered from the current premix (re-mixed, copied or "
                "restored since); export (or re-run master_loudness) first, or publish the premix"
            )
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


def clean_created_version(
    version_dir: Path, identity: DirectoryIdentity, *, project: EpisodeProject | None = None
) -> None:
    """Clean one created directory under the same file lock as project commits."""
    if project is None:
        project_path = version_dir.parent.parent.parent / "episode.project.json"
        if project_path.is_file():
            project = load_project(project_path)
    if project is None:
        # Standalone test directories have no project transaction to coordinate with.
        _clean_created_version_locked(version_dir, identity)
    else:
        with project_commit_lock(project):
            _clean_created_version_locked(version_dir, identity)


def _clean_created_version_locked(version_dir: Path, identity: DirectoryIdentity) -> None:
    if not _SAFE_FAILED_CLEANUP_SUPPORTED:
        log.warning("Safe review cleanup is unavailable; keeping %s", version_dir)
        return
    root = version_dir.parent
    root_fd: int | None = None
    quarantine_fd: int | None = None
    quarantine: Path | None = None
    try:
        root_fd = _open_pinned_dir(root)
        public = version_dir.name
        try:
            current = os.stat(public, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            log.debug("Review version directory already removed: %s", version_dir)
            return
        if not _is_created_dir(current, identity):
            log.warning("Review version directory changed; keeping %s", version_dir)
            return
        quarantine_name = f"{_QUARANTINE_PREFIX}{uuid.uuid4().hex}"
        os.mkdir(quarantine_name, dir_fd=root_fd)
        quarantine = root / quarantine_name
        quarantine_fd = _open_pinned_dir(quarantine_name, dir_fd=root_fd)
        moved = _QUARANTINE_ENTRY
        os.rename(public, moved, src_dir_fd=root_fd, dst_dir_fd=quarantine_fd)
        after = os.stat(moved, dir_fd=quarantine_fd, follow_symlinks=False)
        if not _is_created_dir(after, identity):
            with suppress(OSError):
                # Return a replacement to its public name only when vacant. Never
                # overwrite the directory another writer may have placed there.
                _rename_noreplace(f"{quarantine_name}/{_QUARANTINE_ENTRY}", public, root_fd)
            log.warning(
                "Review version directory changed during quarantine; keeping %s", quarantine
            )
            return
        marker = {"name": version_dir.name, "dev": identity[0], "ino": identity[1]}
        marker_fd = os.open(
            _CLEANUP_MARKER,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=quarantine_fd,
        )
        try:
            os.write(marker_fd, json.dumps(marker).encode())
        finally:
            os.close(marker_fd)
        shutil.rmtree(moved, dir_fd=quarantine_fd)
        os.unlink(_CLEANUP_MARKER, dir_fd=quarantine_fd)
    finally:
        for fd in (quarantine_fd,):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    log.warning("Could not close review cleanup descriptor %d", fd, exc_info=True)
        if quarantine is not None and root_fd is not None:
            try:
                os.rmdir(quarantine.name, dir_fd=root_fd)
            except OSError:
                # A changed directory or failed removal stays available for inspection.
                log.warning("Keeping failed review quarantine %s", quarantine)
        if root_fd is not None:
            try:
                os.close(root_fd)
            except OSError:
                log.warning("Could not close review cleanup descriptor %d", root_fd, exc_info=True)


def sweep_stale_quarantines(project: EpisodeProject) -> None:
    """Bound cleanup to old quarantines carrying a matching ownership record."""
    if not _SAFE_FAILED_CLEANUP_SUPPORTED:
        return
    root = review_artifacts_dir(project)
    if not root.is_dir():
        return
    with project_commit_lock(project):
        root_fd = _open_pinned_dir(root.resolve(strict=True))
        try:
            inspected = 0
            with os.scandir(root_fd) as entries:
                for entry in entries:
                    if inspected >= _STALE_QUARANTINE_LIMIT:
                        break
                    if not entry.name.startswith(_QUARANTINE_PREFIX):
                        continue
                    inspected += 1
                    quarantine_fd: int | None = None
                    try:
                        quarantine_fd = _open_pinned_dir(entry.name, dir_fd=root_fd)
                        with os.scandir(quarantine_fd) as contents:
                            if {item.name for item in contents} != {
                                _CLEANUP_MARKER,
                                _QUARANTINE_ENTRY,
                            }:
                                continue
                        marker_stat = os.stat(
                            _CLEANUP_MARKER, dir_fd=quarantine_fd, follow_symlinks=False
                        )
                        if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_mtime > (
                            time.time() - _STALE_QUARANTINE_AGE_SECONDS
                        ):
                            continue
                        marker_fd = os.open(
                            _CLEANUP_MARKER, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=quarantine_fd
                        )
                        try:
                            marker = json.loads(os.read(marker_fd, 512))
                        finally:
                            os.close(marker_fd)
                        media_stat = os.stat(
                            _QUARANTINE_ENTRY, dir_fd=quarantine_fd, follow_symlinks=False
                        )
                        if not _is_created_dir(
                            media_stat, (marker["dev"], marker["ino"])
                        ) or not isinstance(marker["name"], str):
                            continue
                        shutil.rmtree(_QUARANTINE_ENTRY, dir_fd=quarantine_fd)
                        os.unlink(_CLEANUP_MARKER, dir_fd=quarantine_fd)
                        os.rmdir(entry.name, dir_fd=root_fd)
                    except (OSError, ValueError, KeyError, TypeError):
                        log.warning(
                            "Keeping unsafe review quarantine %s", entry.name, exc_info=True
                        )
                    finally:
                        if quarantine_fd is not None:
                            os.close(quarantine_fd)
        finally:
            os.close(root_fd)


def discard_created_version(
    version_dir: Path, identity: DirectoryIdentity, *, project: EpisodeProject | None = None
) -> None:
    """Best-effort ``clean_created_version`` for error paths; logs a failure, never raises.

    Callers are already propagating an error, so a cleanup failure must not mask it.
    """
    try:
        clean_created_version(version_dir, identity, project=project)
    except BaseException:
        log.warning("Could not remove review version directory %s", version_dir, exc_info=True)


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


def stage_version(
    project: EpisodeProject,
    *,
    label: str,
    prefer: str = "premix",
    eng: FFmpegEngine | None = None,
    on_media_created: Callable[[Path, DirectoryIdentity], None] | None = None,
) -> ReviewMixVersion:
    """Copy current premix/mastered into private staging (+ mix.mp3).

    Creates media only; ``project.review`` is untouched until ``attach_version``.

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
    sweep_stale_quarantines(project)
    resolved_root = review_root.resolve(strict=True)
    version_dir = resolved_root / f"{_STAGING_PREFIX}{uuid.uuid4().hex}"
    root_fd = _open_pinned_dir(resolved_root)
    try:
        os.mkdir(version_dir.name, dir_fd=root_fd)
    finally:
        os.close(root_fd)
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
        discard_created_version(version_dir, created_identity, project=project)
        raise
    return ver


def attach_version(
    project: EpisodeProject, ver: ReviewMixVersion, *, set_active: bool = True
) -> ReviewMixVersion:
    """Record an already-promoted version on the project."""
    audio = review_artifacts_dir(project) / ver.id / "mix.wav"
    if not audio.is_file():
        raise FileNotFoundError(f"review version has not been promoted: {ver.id}")
    project.review.versions.append(ver)
    if set_active:
        project.review.active_version_id = ver.id
    return ver


def publish_version(
    project: EpisodeProject,
    *,
    label: str,
    prefer: str = "premix",
    set_active: bool = True,
    eng: FFmpegEngine | None = None,
    on_media_created: Callable[[Path, DirectoryIdentity], None] | None = None,
) -> ReviewMixVersion:
    """Stage media, then attach it to the project in one call.

    Convenience wrapper for callers without a cross-process commit (tests, scripts).
    Services call ``stage_version`` outside ``project_commit_lock`` and
    ``attach_version`` inside the commit (see ``ReviewService.publish``).
    """
    created: tuple[Path, DirectoryIdentity] | None = None

    def remember(path: Path, identity: DirectoryIdentity) -> None:
        nonlocal created
        created = (path, identity)
        if on_media_created is not None:
            on_media_created(path, identity)

    ver = stage_version(project, label=label, prefer=prefer, eng=eng, on_media_created=remember)
    assert created is not None
    from podcast_mcp.util.project_state import project_commit_lock

    with project_commit_lock(project):
        try:
            promote_staged_version(created[0], created[1], ver.id)
        except BaseException:
            discard_created_version(created[0], created[1], project=project)
            raise
        return attach_version(project, ver, set_active=set_active)


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
