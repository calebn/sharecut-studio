"""Cut a segment out of a project's timeline and put it in the library."""

from __future__ import annotations

import re
import tempfile
from collections.abc import Sequence
from pathlib import Path

from podcast_mcp.engines.clips_ops import extract_clips_in_timeline_range
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.mute_regions import mute_spans_for_source_window
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.models.episode import Clip, EpisodeProject, TrackRole
from podcast_mcp.segments.model import (
    SEGMENT_JSON,
    MediaEntry,
    SegmentClip,
    SegmentFile,
    SegmentKind,
    segment_id_for,
    segment_json,
)
from podcast_mcp.segments.store import AddResult, SegmentStore, sha256_file
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError

EDGE_SEC = 120.0
_CLOCK = re.compile(r"^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)$")


def parse_clock(text: str) -> float:
    """Seconds from ``90``, ``1:30`` or ``1:02:03.5``."""
    match = _CLOCK.fullmatch(text.strip())
    if match is None:
        raise CodedValueError(
            f"{text!r} is not a time. Use 1:30 or 90.", code="segment_range_invalid"
        )
    if match.group(4) is not None:
        return float(match.group(4))
    hours, minutes, seconds = match.group(1), match.group(2), match.group(3)
    return int(hours or 0) * 3600 + int(minutes) * 60 + float(seconds)


def parse_range(text: str) -> tuple[float, float]:
    """A timeline range such as ``0:00-0:22``."""
    start, dash, end = text.partition("-")
    if not dash:
        raise CodedValueError(
            f"{text!r} is not a range. Use 0:00-0:22.", code="segment_range_invalid"
        )
    return parse_clock(start), parse_clock(end)


def guess_kind(start: float, end: float, timeline_end: float) -> SegmentKind:
    if start <= EDGE_SEC:
        return "intro"
    if end >= timeline_end - EDGE_SEC:
        return "outro"
    return "other"


def _selected(
    project: EpisodeProject,
    clip_ids: Sequence[str] | None,
    time_range: tuple[float, float] | None,
) -> list[Clip]:
    if (clip_ids is None) == (time_range is None):
        raise CodedValueError(
            "Choose the clips with clip_ids or a time range, not both and not neither.",
            code="segment_selection_invalid",
        )
    if clip_ids is not None:
        by_id = {clip.id: clip for clip in project.clips}
        missing = [clip_id for clip_id in clip_ids if clip_id not in by_id]
        if missing:
            raise CodedValueError(
                f"There is no clip {missing[0]} in this project.", code="segment_clip_unknown"
            )
        chosen = [by_id[clip_id] for clip_id in dict.fromkeys(clip_ids)]
    else:
        assert time_range is not None
        start, end = time_range
        if end <= start:
            raise CodedValueError(
                "The range must end after it starts.", code="segment_range_invalid"
            )
        chosen = extract_clips_in_timeline_range(project.clips, start, end)
        shift = start
        chosen = [c.model_copy(update={"timeline_start": c.timeline_start + shift}) for c in chosen]
    if not chosen:
        raise CodedValueError("No clips are in that selection.", code="segment_selection_empty")
    return sorted(chosen, key=lambda clip: clip.timeline_start)


def capture_segment(
    workspace: ProjectWorkspace,
    *,
    name: str,
    directory: Path,
    kind: SegmentKind | None = None,
    clip_ids: Sequence[str] | None = None,
    time_range: tuple[float, float] | None = None,
    role: TrackRole | None = None,
) -> SegmentFile:
    """Write a segment folder (``segment.json`` and FLAC audio) into ``directory``.

    Layout offsets count from the earliest selected clip. The role and fader come from
    the first clip's track unless ``role`` overrides the role.
    """
    project = workspace.project
    clips = _selected(project, clip_ids, time_range)
    first = clips[0]
    first_track = project.track_by_id(first.track_id)
    if first_track is None:
        raise CodedValueError(f"Track {first.track_id} is missing.", code="segment_clip_unknown")
    origin = first.timeline_start
    end = max(clip.timeline_end for clip in clips)
    timeline_end = max((clip.timeline_end for clip in project.clips), default=end)
    chosen_kind = kind or guess_kind(origin, end, timeline_end)

    lanes: dict[str, int] = {}
    engine = FFmpegEngine()
    directory.mkdir(parents=True, exist_ok=True)
    segment_clips: list[SegmentClip] = []
    media: dict[str, MediaEntry] = {}
    with tempfile.TemporaryDirectory(prefix="segment-cut-") as scratch:
        for index, clip in enumerate(clips, start=1):
            track = project.track_by_id(clip.track_id)
            if track is None:
                raise CodedValueError(
                    f"Track {clip.track_id} is missing.", code="segment_clip_unknown"
                )
            source = resolve_clip_audio_path(project, track, clip)
            cut = Path(scratch) / f"cut-{index}.wav"
            engine.extract_segment(
                source,
                cut,
                clip.source_start,
                clip.source_end,
                mute_spans=mute_spans_for_source_window(clip, clip.source_start, clip.source_end),
            )
            audio = f"clip-{index:02d}.flac"
            rate, channels, chunks = engine.stream_pcm_f32(cut)
            engine.encode_flac_f32(chunks, directory / audio, sample_rate=rate, channels=channels)
            path = directory / audio
            media[audio] = MediaEntry(sha256=sha256_file(path), bytes=path.stat().st_size)
            segment_clips.append(
                SegmentClip(
                    audio=audio,
                    offset_sec=round(clip.timeline_start - origin, 6),
                    duration_sec=round(clip.source_end - clip.source_start, 6),
                    fade_in_ms=clip.fade_in_ms,
                    fade_out_ms=clip.fade_out_ms,
                    join_in_mode=clip.join_in_mode,
                    lane=lanes.setdefault(clip.track_id, len(lanes)),
                )
            )
    segment = SegmentFile(
        id=segment_id_for(name),
        name=name.strip(),
        kind=chosen_kind,
        role=role or first_track.role,
        fader_db=first_track.fader_db,
        clips=segment_clips,
        media=media,
    )
    write_text_atomic(directory / SEGMENT_JSON, segment_json(segment))
    return segment


def save_segment(
    workspace: ProjectWorkspace,
    store: SegmentStore,
    *,
    name: str,
    kind: SegmentKind | None = None,
    clip_ids: Sequence[str] | None = None,
    time_range: tuple[float, float] | None = None,
    role: TrackRole | None = None,
) -> AddResult:
    """Capture a segment from the project and add it to ``store``."""
    with tempfile.TemporaryDirectory(prefix="segment-capture-") as scratch:
        capture_segment(
            workspace,
            name=name,
            directory=Path(scratch),
            kind=kind,
            clip_ids=clip_ids,
            time_range=time_range,
            role=role,
        )
        return store.add(Path(scratch))
