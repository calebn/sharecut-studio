"""Project media refs for waveform pyramids, plus the build hooks callers share.

A media ref names one media file the viewer draws a waveform for:

- ``track:<id>`` — the track's ``media`` (listed when the track has media);
- ``source:<id>`` — a ``project.sources`` row, resolved like
  ``engines/timeline_render.resolve_clip_audio_path`` (pinned by
  ``test_source_ref_resolves_like_clip_render``; listed when at least one
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
from podcast_mcp.engines.play_audit import stem_hash_path, stem_is_fresh, stem_path
from podcast_mcp.engines.waveform_pyramid import (
    PyramidMeta,
    build_pyramid,
    media_key,
    pyramid_path,
    read_meta,
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


@dataclass(frozen=True)
class _Candidate:
    """A ref before any availability check: its workspace-safe path, or why it has none."""

    ref: str
    kind: MediaKind
    path: Path | None = None
    reason: str = REASON_NO_MEDIA


def _stored_candidate(project: EpisodeProject, ref: str, stored: str) -> _Candidate | None:
    """Raw candidate for a stored media path; ``None`` when the path escapes the workspace."""
    try:
        path = resolve_under_workspace(project, stored)
    except ValueError:
        log.debug("waveform media path escaped the workspace: %s", stored)
        return None
    return _Candidate(ref=ref, kind="raw", path=path)


def _track_candidate(project: EpisodeProject, track: Track) -> _Candidate | None:
    if track.media is None:
        return None
    return _stored_candidate(project, f"track:{track.id}", track.media.path)


def _source_candidate(project: EpisodeProject, source_id: str) -> _Candidate | None:
    ref = f"source:{source_id}"
    source = project.source_by_id(source_id)
    if source is None:
        return _Candidate(ref=ref, kind="raw")
    return _stored_candidate(project, ref, source.path)


def _stem_candidate(project: EpisodeProject, track_id: str) -> _Candidate | None:
    ref = f"stem:{track_id}"
    if not SAFE_TRACK_ID.fullmatch(track_id):
        return _Candidate(ref=ref, kind="stem", reason=REASON_UNSAFE_ID)
    stem = stem_path(project, track_id)
    try:
        path = resolve_within(stem.parent, stem.name)
    except ValueError:
        return None
    return _Candidate(ref=ref, kind="stem", path=path)


def _clip_source_ids(project: EpisodeProject, track_id: str | None = None) -> list[str]:
    """Sorted source ids referenced by clips (only *track_id*'s lane when given)."""
    return sorted(
        {
            c.source_id
            for c in project.clips
            if c.source_id and (track_id is None or c.track_id == track_id)
        }
    )


def _project_candidates(project: EpisodeProject) -> list[_Candidate | None]:
    """Every ref of *project* in listing order: track media, clip sources, then stems."""
    found = [_track_candidate(project, t) for t in project.tracks]
    found += [_source_candidate(project, s) for s in _clip_source_ids(project)]
    found += [_stem_candidate(project, t.id) for t in project.tracks if t.media is not None]
    return found


def _resolve(
    project: EpisodeProject, candidates: list[_Candidate | None], *, fresh_only: bool
) -> MediaRefs:
    """Check each candidate on disk: drawable refs, or refs that exist but cannot be drawn."""
    out = MediaRefs(refs={}, unavailable={})
    for cand in candidates:
        if cand is None:
            continue
        if cand.path is None:
            out.unavailable[cand.ref] = cand.reason
            continue
        _, _, ref_id = cand.ref.partition(":")
        if cand.kind == "stem" and fresh_only and not stem_is_fresh(project, ref_id):
            continue
        if not cand.path.is_file():
            if cand.kind == "raw":
                out.unavailable[cand.ref] = REASON_NO_MEDIA
            continue
        out.refs[cand.ref] = MediaEntry(
            kind=cand.kind, abs_path=cand.path, rel_path=workspace_relpath(project, cand.path)
        )
    return out


def collect_media_refs(project: EpisodeProject) -> MediaRefs:
    """Every raw and (fresh) stem ref of *project*."""
    return _resolve(project, _project_candidates(project), fresh_only=True)


def media_watch_paths(project: EpisodeProject) -> tuple[Path, ...]:
    """Files whose appearance or change can flip a ref without touching the project JSON.

    Derived from the same walk as ``collect_media_refs``: each candidate's path, plus
    the ``.hash`` sidecar of each stem (an input to ``stem_is_fresh``).
    """
    paths: list[Path] = []
    for cand in _project_candidates(project):
        if cand is None or cand.path is None:
            continue
        paths.append(cand.path)
        if cand.kind == "stem":
            paths.append(stem_hash_path(project, cand.ref.partition(":")[2]))
    return tuple(paths)


def track_media_refs(project: EpisodeProject, track: Track) -> MediaRefs:
    """The track ref plus the source refs of the clips on *track*'s lane."""
    candidates = [_track_candidate(project, track)]
    candidates += [_source_candidate(project, s) for s in _clip_source_ids(project, track.id)]
    return _resolve(project, candidates, fresh_only=False)


def current_key(entry: MediaEntry) -> str:
    """Pyramid key of *entry*'s media as it is on disk now (``OSError`` if it is gone).

    Request handlers call ``services.waveform.live_key`` instead: it turns a missing
    file into ``LookupError`` (404), where a bare ``OSError`` would become a 500.
    """
    st = entry.abs_path.stat()
    return media_key(entry.rel_path, st.st_size, st.st_mtime_ns)


def pyramid_target(artifacts_dir: Path, ref: str, entry: MediaEntry) -> PyramidTarget:
    """Current key and file for *ref* (``stat()`` on every call; ``OSError`` if gone)."""
    kind, _, ref_id = ref.partition(":")
    key = current_key(entry)
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
    candidates = [_stem_candidate(project, track_id) for track_id in track_ids]
    refs = _resolve(project, candidates, fresh_only=False).refs
    artifacts = project.artifacts_dir()
    return sum(schedule_media_ref(artifacts, ref, entry) for ref, entry in refs.items())


def ensure_track_waveforms(project: EpisodeProject, track: Track, *, sources: bool = True) -> int:
    """Build *track*'s pyramids inline; returns how many are on disk after.

    ``sources=False`` builds only the ``track:<id>`` ref (what social-clip energy
    reads) and skips the source refs of the clips on the lane.
    """
    if sources:
        refs = track_media_refs(project, track).refs
    else:
        refs = _resolve(project, [_track_candidate(project, track)], fresh_only=False).refs
    ready = 0
    artifacts = project.artifacts_dir()
    for ref, entry in refs.items():
        try:
            target = pyramid_target(artifacts, ref, entry)
            if not target.out.is_file():
                build_pyramid(ref, target.key, entry.abs_path, target.out)
        except Exception as exc:
            log.debug("waveform pyramid build failed for %s: %s", ref, exc)
            continue
        ready += 1
    return ready


def ensure_project_waveforms(project: EpisodeProject, *, sources: bool = True) -> int:
    """``ensure_track_waveforms`` for every track with media; returns the total on disk."""
    return sum(
        ensure_track_waveforms(project, t, sources=sources) for t in project.tracks if t.media
    )


def track_pyramid(project: EpisodeProject, track_id: str) -> tuple[Path, PyramidMeta] | None:
    """The ready ``track:<id>`` pyramid for the track's current media, if one is on disk.

    Never builds. Raises ``ValueError`` when the file is corrupt and ``OSError``
    when the media vanishes mid-call.
    """
    track = project.track_by_id(track_id)
    if track is None:
        return None
    resolved = track_media_refs(project, track).refs.get(f"track:{track_id}")
    if resolved is None:
        return None
    target = pyramid_target(project.artifacts_dir(), f"track:{track_id}", resolved)
    if not target.out.is_file():
        return None
    return target.out, read_meta(target.out)
