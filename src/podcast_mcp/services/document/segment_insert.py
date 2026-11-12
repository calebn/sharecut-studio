"""Insert a saved segment into an episode, as one undoable edit."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from podcast_mcp.edits.segment_insert import (
    SegmentAudio,
    check_layout,
    check_position,
    insert_segment,
    timeline_end,
)
from podcast_mcp.engines.track_media import media_asset_from_path
from podcast_mcp.models import EpisodeProject
from podcast_mcp.segments.model import SegmentFile
from podcast_mcp.segments.position import parse_position
from podcast_mcp.segments.store import SegmentStore, sha256_file
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.segment_insert_results import (
    ChapterMove,
    CommentMove,
    SegmentInsertApplied,
    SegmentInsertPreview,
)
from podcast_mcp.util.coded_error import CodedValueError


def _mismatch(segment: SegmentFile, name: str) -> CodedValueError:
    return CodedValueError(
        f"The audio file {name} of segment {segment.name!r} does not match its recorded hash.",
        code="segment_hash_mismatch",
    )


def copy_segment_audio(
    workspace_dir: Path, segment: SegmentFile, folder: Path
) -> dict[str, SegmentAudio]:
    """Copy each audio file of a stored segment into ``raw/`` and check the copy's hash.

    The name is the content hash, so inserting the same segment twice stores its audio once.
    The hash is checked on the copy, not the library file, so a file changed after the
    library read it cannot get in.
    """
    raw = workspace_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    out: dict[str, SegmentAudio] = {}
    for name, entry in segment.media.items():
        dest = raw / f"segment-{entry.sha256}{Path(name).suffix}"
        # Always a fresh copy: a file already at the name is never trusted or probed.
        fd, tmp_name = tempfile.mkstemp(prefix=".segment-", suffix=Path(name).suffix, dir=raw)
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            shutil.copyfile(folder / name, tmp)
            if sha256_file(tmp) != entry.sha256:
                raise _mismatch(segment, name)
            asset = media_asset_from_path(tmp, store_path=f"raw/{dest.name}")
            os.replace(tmp, dest)
        except OSError as exc:
            raise CodedValueError(
                f"The audio file {name} of segment {segment.name!r} could not be copied: "
                f"{exc.strerror or exc}.",
                code="segment_write_failed",
            ) from exc
        finally:
            tmp.unlink(missing_ok=True)
        out[name] = SegmentAudio(
            source_id=f"seg_{entry.sha256}",
            path=asset.path,
            duration_sec=float(asset.duration_sec or 0.0),
            sample_rate=int(asset.sample_rate or 0),
            channels=int(asset.channels or 0),
        )
    return out


def resolve_insert_position(project: EpisodeProject, at: object) -> float:
    """``start``, ``end`` or seconds, as a second on ``project``'s timeline.

    The one place the words are read: ``end`` is the end of ``project`` as it is now, so call
    it on the project you are about to edit. Raises ``segment_position_out_of_range`` for
    anything else (see :func:`podcast_mcp.segments.position.parse_position`).
    """
    parsed = parse_position(at)
    if parsed == "start":
        return 0.0
    if parsed == "end":
        return timeline_end(project)
    return parsed


def insert_saved_segment(
    ws: ProjectWorkspace,
    segment_id: str,
    at: float | str,
    *,
    version: int | None = None,
    store: SegmentStore | None = None,
) -> SegmentInsertApplied:
    """Insert a library segment at ``at`` (seconds, ``start`` or ``end``); later content moves.

    ``end`` is read inside the document lock, so an edit saved meanwhile is not split. The audio is copied into the project and its hash checked. The edit is one undo step.
    Errors: ``segment_unknown``, ``segment_hash_mismatch``, ``segment_media_invalid``,
    ``segment_write_failed``, ``segment_position_out_of_range``.
    """
    library = store or SegmentStore()
    segment = library.get(segment_id, version)
    early = resolve_insert_position(ws.project, at)
    check_position(ws.project, early)
    check_layout(segment)
    audio = copy_segment_audio(
        Path(ws.project.workspace_dir), segment, library.path(segment.id, segment.version)
    )
    return ws.mutate(
        f"before insert segment {segment.name}",
        f"after insert segment {segment.name}",
        lambda p: SegmentInsertApplied.model_validate(
            insert_segment(
                p, segment, audio, resolve_insert_position(p, at), defaults=ws.effective_config()
            )
        ),
        operation="insert_segment",
        params={"segment_id": segment.id, "version": segment.version, "at": early},
    )


def _chapters_moved(
    project: EpisodeProject, trial: EpisodeProject, segment: SegmentFile, at: float
) -> list[ChapterMove]:
    after = sorted(trial.editorial.chapters, key=lambda chapter: chapter.time)
    if segment.chapter_title:
        added = next((c for c in after if c.title == segment.chapter_title and c.time == at), None)
        if added is not None:
            after.remove(added)
    before = sorted(project.editorial.chapters, key=lambda chapter: chapter.time)
    return [
        ChapterMove(title=new.title, from_sec=old.time, to=new.time)
        for old, new in zip(before, after, strict=False)
        if old.time != new.time
    ]


def preview_segment_insert(
    ws: ProjectWorkspace,
    segment_id: str,
    at: float | str,
    *,
    version: int | None = None,
    store: SegmentStore | None = None,
) -> SegmentInsertPreview:
    report, _trial = preview_segment_insert_on(
        ws, ws.project, segment_id, at, version=version, store=store
    )
    return report


def preview_segment_insert_on(
    ws: ProjectWorkspace,
    project: EpisodeProject,
    segment_id: str,
    at: float | str,
    *,
    version: int | None = None,
    store: SegmentStore | None = None,
) -> tuple[SegmentInsertPreview, EpisodeProject]:
    """:func:`preview_segment_insert` on ``project`` (a copy the caller owns) and the result.

    Returns the report and the project as it would be after the insert, so a kit's dry run
    can feed one entry's result to the next. ``ws`` only supplies the config defaults.
    Nothing is written. ``at`` is read as for an insert. The library audio is hash-checked and
    probed in place, so audio shorter than its layout is refused as an insert refuses it. The
    report holds the new duration and what would move; same errors as an insert, bar the
    copy failing.
    """
    library = store or SegmentStore()
    segment = library.get(segment_id, version)
    at = resolve_insert_position(project, at)
    check_position(project, at)
    check_layout(segment)
    folder = library.path(segment.id, segment.version)
    audio = {}
    for name, entry in segment.media.items():
        try:
            asset = media_asset_from_path(
                folder / name, store_path=f"raw/segment-{entry.sha256}{Path(name).suffix}"
            )
        except OSError as exc:
            raise CodedValueError(
                f"The audio file {name} of segment {segment.name!r} could not be read: "
                f"{exc.strerror or exc}.",
                code="segment_write_failed",
            ) from exc
        audio[name] = SegmentAudio(
            source_id=f"seg_{entry.sha256}",
            path=asset.path,
            duration_sec=float(asset.duration_sec or 0.0),
            sample_rate=int(asset.sample_rate or 0),
            channels=int(asset.channels or 0),
        )
    trial = project.model_copy(deep=True)
    summary = insert_segment(trial, segment, audio, at, defaults=ws.effective_config())
    before = {clip.id: clip.timeline_start for clip in project.clips}
    kept = [clip for clip in trial.clips if clip.id in before]
    old_tracks = {track.id for track in project.tracks}
    old_comments = {c.id: c.timeline_start for c in project.review.comments}
    old_pending = {e.id: (e.start, e.end) for e in project.editorial.edit_decisions}
    report = SegmentInsertPreview(
        segment_id=segment.id,
        segment_version=segment.version,
        at=at,
        duration_sec=segment.duration_sec,
        timeline_duration_before_sec=timeline_end(project),
        timeline_duration_after_sec=timeline_end(trial),
        clips_moved=sum(1 for clip in kept if clip.timeline_start != before[clip.id]),
        clips_added=len(trial.clips) - len(before),
        clips_from_segment=len(segment.clips),
        chapters_moved=_chapters_moved(project, trial, segment, at),
        chapter_added=segment.chapter_title,
        comments_moved=[
            CommentMove(id=c.id, from_sec=old_comments[c.id], to=c.timeline_start)
            for c in trial.review.comments
            if c.id in old_comments and c.timeline_start != old_comments[c.id]
        ],
        pending_edits_moved=sum(
            1
            for e in trial.editorial.edit_decisions
            if e.id in old_pending and (e.start, e.end) != old_pending[e.id]
        ),
        tracks_added=[t.id for t in trial.tracks if t.id not in old_tracks],
        tracks=summary["tracks"],
    )
    return report, trial
