"""Project media refs for waveform pyramids, plus the build hooks callers share.

A media ref names one media file the viewer draws a waveform for:

- ``track:<id>`` — the track's ``media`` (listed when the track has media);
- ``source:<id>`` — a ``project.sources`` row, resolved like
  ``engines/timeline_render.resolve_clip_audio_path`` (listed when at least one
  clip references it);
- ``stem:<id>`` — ``artifacts/tracks/<id>.wav`` (listed only while
  ``stem_is_fresh``; ids must match ``SAFE_TRACK_ID``).

``raw`` covers ``track:``/``source:`` refs; ``stem`` covers ``stem:`` refs. The
pyramid for a ref lives at ``artifacts/peaks/{ref_slug}.{key}.wfpk``
(``engines/waveform_pyramid``). These hooks live in the engine layer so the
pipeline never imports ``services``; ``services/waveform`` re-exports them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from podcast_mcp.edits.track_ids import SAFE_TRACK_ID
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.engines.waveform_pyramid import (
    build_pyramid,
    media_key,
    pyramid_path,
    ref_slug,
    schedule_pyramid_build,
)
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.util.workspace_paths import (
    resolve_under_workspace,
    resolve_within,
    workspace_relpath,
)

log = logging.getLogger(__name__)

MediaKind = Literal["raw", "stem"]

REASON_NO_MEDIA = "no-media"
REASON_DECODE_FAILED = "decode-failed"
REASON_UNSAFE_ID = "unsafe-id"


@dataclass(frozen=True)
class MediaEntry:
    kind: MediaKind
    abs_path: Path
    rel_path: str


@dataclass(frozen=True)
class MediaRefs:
    """Resolvable refs, plus refs that exist but cannot be drawn (ref -> reason)."""

    refs: dict[str, MediaEntry]
    unavailable: dict[str, str]


@dataclass(frozen=True)
class PyramidTarget:
    slug: str
    key: str
    out: Path


def _resolve_media(
    project: EpisodeProject, stored: str, kind: MediaKind
) -> MediaEntry | str | None:
    """Entry, a ``no-media`` reason, or ``None`` when the path escapes the workspace."""
    try:
        path = resolve_under_workspace(project, stored)
    except ValueError:
        log.debug("waveform media path escaped the workspace: %s", stored)
        return None
    if not path.is_file():
        return REASON_NO_MEDIA
    return MediaEntry(kind=kind, abs_path=path, rel_path=workspace_relpath(project, path))


def _add(out: MediaRefs, ref: str, resolved: MediaEntry | str | None) -> None:
    if isinstance(resolved, MediaEntry):
        out.refs[ref] = resolved
    elif resolved is not None:
        out.unavailable[ref] = resolved


def _track_ref(project: EpisodeProject, track: Track, out: MediaRefs) -> None:
    if track.media is not None:
        _add(out, f"track:{track.id}", _resolve_media(project, track.media.path, "raw"))


def _source_ref(project: EpisodeProject, source_id: str, out: MediaRefs) -> None:
    source = project.source_by_id(source_id)
    ref = f"source:{source_id}"
    if source is None:
        out.unavailable[ref] = REASON_NO_MEDIA
        return
    _add(out, ref, _resolve_media(project, source.path, "raw"))


def _stem_ref(project: EpisodeProject, track_id: str, out: MediaRefs, *, fresh_only: bool) -> None:
    ref = f"stem:{track_id}"
    if not SAFE_TRACK_ID.fullmatch(track_id):
        out.unavailable[ref] = REASON_UNSAFE_ID
        return
    if fresh_only and not stem_is_fresh(project, track_id):
        return
    try:
        path = resolve_within(project.artifacts_dir() / "tracks", f"{track_id}.wav")
    except ValueError:
        return
    if not path.is_file():
        return
    out.refs[ref] = MediaEntry(
        kind="stem", abs_path=path, rel_path=workspace_relpath(project, path)
    )


def collect_media_refs(project: EpisodeProject) -> MediaRefs:
    """Every raw and (fresh) stem ref of *project*."""
    out = MediaRefs(refs={}, unavailable={})
    for track in project.tracks:
        _track_ref(project, track, out)
    for source_id in sorted({c.source_id for c in project.clips if c.source_id}):
        _source_ref(project, source_id, out)
    for track in project.tracks:
        if track.media is not None:
            _stem_ref(project, track.id, out, fresh_only=True)
    return out


def track_media_refs(project: EpisodeProject, track: Track) -> MediaRefs:
    """The track ref plus the source refs of the clips on *track*'s lane."""
    out = MediaRefs(refs={}, unavailable={})
    _track_ref(project, track, out)
    source_ids = {c.source_id for c in project.clips if c.track_id == track.id and c.source_id}
    for source_id in sorted(source_ids):
        _source_ref(project, source_id, out)
    return out


def pyramid_target(artifacts_dir: Path, ref: str, entry: MediaEntry) -> PyramidTarget:
    """Current key and file for *ref* (``stat()`` on every call; ``OSError`` if gone)."""
    kind, _, ref_id = ref.partition(":")
    st = entry.abs_path.stat()
    key = media_key(entry.rel_path, st.st_size, st.st_mtime_ns)
    slug = ref_slug(kind, ref_id)
    return PyramidTarget(slug=slug, key=key, out=pyramid_path(artifacts_dir / "peaks", slug, key))


def schedule_media_ref(artifacts_dir: Path, ref: str, entry: MediaEntry) -> bool:
    """Queue a background build unless the pyramid exists; ``True`` when ready or queued."""
    try:
        target = pyramid_target(artifacts_dir, ref, entry)
    except OSError:
        return False
    if target.out.is_file():
        return True
    return schedule_pyramid_build(ref, target.key, entry.abs_path, target.out)


def schedule_track_waveforms(project: EpisodeProject, track: Track) -> int:
    """Queue pyramids for *track* and its clips' sources; returns refs ready or queued."""
    refs = track_media_refs(project, track).refs
    artifacts = project.artifacts_dir()
    return sum(schedule_media_ref(artifacts, ref, entry) for ref, entry in refs.items())


def schedule_stem_waveforms(project: EpisodeProject, track_ids: list[str]) -> int:
    """Queue pyramids for just-rendered stems (safe ids with a stem file)."""
    out = MediaRefs(refs={}, unavailable={})
    for track_id in track_ids:
        _stem_ref(project, track_id, out, fresh_only=False)
    artifacts = project.artifacts_dir()
    return sum(schedule_media_ref(artifacts, ref, entry) for ref, entry in out.refs.items())


def ensure_track_waveforms(project: EpisodeProject, track: Track) -> int:
    """Build *track*'s pyramids inline (pipeline); returns how many are on disk after."""
    ready = 0
    artifacts = project.artifacts_dir()
    for ref, entry in track_media_refs(project, track).refs.items():
        try:
            target = pyramid_target(artifacts, ref, entry)
            if not target.out.is_file():
                build_pyramid(ref, target.key, entry.abs_path, target.out)
        except Exception as exc:
            log.debug("waveform pyramid build failed for %s: %s", ref, exc)
            continue
        ready += 1
    return ready
