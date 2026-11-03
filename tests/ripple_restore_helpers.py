"""A two-lane episode, with comments, chapters and words, for ripple-cut Restore tests (#3114)."""

from __future__ import annotations

from pathlib import Path

from pause_policy_public_helpers import RATE, add_bed, configure, defaults, room, voice, write_wav
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import (
    ChapterMarker,
    Clip,
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    TimelineComment,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.models.clip_timing import ClipTiming, TimingStep
from podcast_mcp.services.app import ProjectWorkspace

LENGTH = 12.0
WORDS = [
    ("alpha", 0.2, 0.5),
    ("um", 1.0, 1.3),
    ("beta", 1.5, 1.8),
    ("uh", 3.0, 3.3),
    ("gamma", 4.0, 4.4),
    ("delta", 6.0, 6.4),
]


def comment(comment_id: str, start: float, end: float | None = None) -> TimelineComment:
    return TimelineComment(
        id=comment_id,
        body=comment_id,
        author="t",
        created_at="2026-01-01T00:00:00Z",
        timeline_start=start,
        timeline_end=end,
    )


def build(tmp_path: Path, *, layout: str = "whole") -> EpisodeProject:
    """``whole``: one clip per lane. ``hole-left``/``hole-right``: no lane joins at the seam of a
    cut over ``[1.0, 1.9)``, so the pad lands at the nearest join, 0.05 s left or right of it."""
    project = EpisodeProject.create("ripple restore", str(tmp_path))
    lanes = ("host", "guest", "extra") if layout.startswith("hole") else ("host", "guest")
    for tid, seed in zip(lanes, (1214, 1215, 1217), strict=False):
        audio = room(LENGTH, seed=seed)
        voice(audio, 0, 0.4)
        write_wav(tmp_path / "raw" / f"{tid}.wav", audio)
    project.tracks = [
        Track(
            id=tid,
            label=tid.title(),
            role=TrackRole.DIALOGUE,
            media=MediaAsset(
                path=f"raw/{tid}.wav", duration_sec=LENGTH, sample_rate=RATE, channels=1
            ),
        )
        for tid in lanes
    ]
    timing = ClipTiming(steps=[TimingStep(at=8.0, delta_sec=0.02)])

    def clip(cid: str, tid: str, a: float, b: float, at: float, **kw) -> Clip:
        return Clip(id=cid, track_id=tid, source_start=a, source_end=b, timeline_start=at, **kw)

    if layout == "edges":
        project.clips = [
            clip("host-l", "host", 0, 1.0, 0, fade_out_ms=7),
            clip("host-m", "host", 1.0, 1.9, 1.0),
            clip(
                "host-r",
                "host",
                1.9,
                LENGTH,
                1.9,
                fade_in_ms=11,
                join_in_mode=ClipJoinMode.CROSSFADE,
            ),
            clip("guest", "guest", 0, LENGTH, 0, timing=timing),
        ]
    elif layout == "whole":
        project.clips = [
            clip("host", "host", 0, LENGTH, 0),
            clip("guest", "guest", 0, LENGTH, 0, timing=timing),
        ]
    else:
        project.clips = [
            clip("host-a", "host", 0, 0.97, 0),
            clip("host-b", "host", 1.0, LENGTH, 1.0),
            clip("guest-a", "guest", 0, 0.97, 0),
            clip("guest-b", "guest", 1.0, LENGTH, 1.0, timing=timing),
        ]
        project.clips += (
            [
                clip("extra-a", "extra", 0, 0.95, 0),
                clip("extra-b", "extra", 0.95, 0.97, 0.95),
                clip("extra-c", "extra", 2.5, LENGTH, 2.5),
            ]
            if layout == "hole-left"
            else [
                clip("extra-a", "extra", 0, 0.5, 0),
                clip("extra-b", "extra", 1.9, 1.95, 1.9),
                clip("extra-c", "extra", 1.95, LENGTH, 1.95),
            ]
        )
    project.timeline.duration_sec = LENGTH + 0.02
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=text, start=start, end=end, suppressed=text == "beta")
                for text, start, end in WORDS
            ],
        )
    ]
    project.review.comments = [
        comment("before", 0.5),
        comment("inside", 1.5),
        comment("overlap-start", 1.8, 3.5),
        comment("spanning", 0.5, 5.0),
        comment("later", 7.0, 7.5),
    ]
    project.editorial.chapters = [
        ChapterMarker(time=0.2, title="intro"),
        ChapterMarker(time=1.5, title="inside"),
        ChapterMarker(time=5.0, title="later"),
    ]
    return project


def cut(edit_id: str, start: float, end: float, *, gap: float | None = None) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        replace_gap_sec=gap,
        reason="filler:um",
        applied=False,
        scope="session",
        boundary_mode="exact",
        review_required=False,
    )


def workspace(
    project: EpisodeProject, monkeypatch, tmp_path: Path, *, pad_mode: str = "room_tone"
) -> ProjectWorkspace:
    configure(monkeypatch, defaults(mode=pad_mode))
    if pad_mode == "room_tone":
        for track in project.tracks:
            add_bed(project, tmp_path, track.id)
    REFINE_GATE.mark_done(project, notes="Literal synthetic fixture. No owner audio acceptance.")
    return ProjectWorkspace.open(save_project(project))
