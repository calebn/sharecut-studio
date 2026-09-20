"""Probe audio and attach a full-span clip to a track (shared by episode + ingest)."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.clips_ops import new_clip_id, set_track_clips
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track


def media_asset_from_path(audio_path: Path, *, store_path: str) -> MediaAsset:
    """ffprobe *audio_path* and return a MediaAsset with *store_path* as the project path."""
    probe = FFmpegEngine().probe(Path(audio_path))
    return MediaAsset(
        path=store_path,
        duration_sec=probe.duration_sec,
        sample_rate=probe.sample_rate,
        channels=probe.channels,
    )


def full_span_clip(track_id: str, duration_sec: float) -> Clip:
    return Clip(
        id=new_clip_id(),
        track_id=track_id,
        source_start=0.0,
        source_end=float(duration_sec),
        timeline_start=0.0,
    )


def refresh_timeline_duration(project: EpisodeProject) -> None:
    if project.clips:
        project.timeline.duration_sec = max(c.timeline_end for c in project.clips)
    else:
        project.timeline.duration_sec = None


def apply_full_span_media(
    project: EpisodeProject,
    track: Track,
    *,
    store_path: str,
    audio_path: Path,
) -> MediaAsset:
    """Set *track*.media from probe and replace that track's clips with one full-span clip."""
    media = media_asset_from_path(audio_path, store_path=store_path)
    track.media = media
    duration = float(media.duration_sec or 0.0)
    set_track_clips(project, track.id, [full_span_clip(track.id, duration)])
    refresh_timeline_duration(project)
    return media


def ensure_audio_in_workspace(workspace_dir: Path, audio: Path) -> tuple[Path, str]:
    """Return ``(absolute_file, relative_store_path)``, copying into ``raw/`` if needed."""
    from podcast_mcp.services.media_store import unique_raw_path

    resolved = audio.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"audio file not found: {resolved}")
    ws = workspace_dir.expanduser().resolve()
    if resolved.is_relative_to(ws):
        rel = str(resolved.relative_to(ws)).replace("\\", "/")
        return resolved, rel
    dest = unique_raw_path(ws, resolved.name)
    dest.write_bytes(resolved.read_bytes())
    rel = str(dest.relative_to(ws)).replace("\\", "/")
    return dest, rel


def resolve_workspace_raw_audio(workspace_dir: Path, rel_path: str) -> Path:
    """Resolve *rel_path* to a file under workspace ``raw/``.

    Rejects absolute paths, ``..`` segments, and anything outside ``raw/``.
    """
    raw_rel = rel_path.replace("\\", "/").strip()
    candidate = Path(raw_rel)
    if not raw_rel or candidate.is_absolute():
        raise ValueError("rel_path must be a relative path under raw/")
    parts = candidate.parts
    if ".." in parts or parts[0] != "raw":
        raise ValueError("rel_path must be a relative path under raw/")
    ws = workspace_dir.expanduser().resolve()
    resolved = (ws / candidate).resolve()
    raw_root = (ws / "raw").resolve()
    if not resolved.is_relative_to(raw_root):
        raise ValueError("rel_path must be a relative path under raw/")
    return resolved
