"""Freeze review mix versions under artifacts/review/{id}/."""

from __future__ import annotations

import logging
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import EpisodeProject, ReviewMixVersion
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.workspace_paths import resolve_within

log = logging.getLogger(__name__)

_REVIEW_MP3_BITRATE_KBPS = 128
REVIEW_ARTIFACTS_RELDIR = "artifacts/review"


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
    mp3_rel = f"{REVIEW_ARTIFACTS_RELDIR}/{version_id}/mix.mp3"
    mp3_path = Path(project.workspace_dir) / mp3_rel
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    engine = eng or FFmpegEngine()
    engine.export_mp3(wav, mp3_path, bitrate_kbps=_REVIEW_MP3_BITRATE_KBPS)
    ver.mp3_relpath = mp3_rel
    return mp3_path.resolve()


def publish_version(
    project: EpisodeProject,
    *,
    label: str,
    prefer: str = "premix",
    set_active: bool = True,
    eng: FFmpegEngine | None = None,
) -> ReviewMixVersion:
    """Copy current premix/mastered into artifacts/review/{id}/mix.wav (+ mix.mp3)."""
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
    dest = version_dir / "mix.wav"
    mp3_rel = f"{REVIEW_ARTIFACTS_RELDIR}/{vid}/mix.mp3"
    mp3_path = version_dir / "mix.mp3"
    try:
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
            shutil.rmtree(version_dir)
        except OSError:
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
