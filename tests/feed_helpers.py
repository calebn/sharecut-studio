"""Builders for podcast-listing tests: a project, a stub show and export files."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from podcast_mcp.feed.model import (
    ExportFile,
    ExportFiles,
    FeedInputs,
    Person,
    ShowId,
    ShowProfile,
    ShowSummary,
)
from podcast_mcp.models import ChapterMarker, EpisodeProject, SocialClipCandidate, Track, TrackRole
from podcast_mcp.models.episode import Transcript
from podcast_mcp.models.feed import Pin

EXPORTED_AT = datetime(2026, 10, 23, 9, 0, tzinfo=UTC)
TEMPLATE = "https://cdn.example.test/long-river/{file}"


@dataclass(frozen=True)
class StubShow:
    id: ShowId = "long-river"
    pins: Mapping[str, Pin] = field(default_factory=dict)
    roster: Sequence[Person] = ()
    media_url: str | None = None


def pin(value: object, by: str = "person", basis: str | None = None) -> Pin:
    return Pin.model_validate({"value": value, "by": by, "basis": basis})


def complete_show(**overrides: object) -> StubShow:
    """A show with every channel fact a feed needs, so only the episode decides the findings."""
    pins = {
        "channel.title": pin("The Long River"),
        "channel.description": pin("A show about water and the people who move it."),
        "channel.link": pin("https://long-river.example.test"),
        "channel.language": pin("en"),
        "channel.author": pin("Ana Reyes"),
        "channel.category": pin("Society & Culture"),
        "channel.explicit": pin(False),
        "channel.image": pin("https://cdn.example.test/long-river/cover.jpg"),
        "channel.owner.name": pin("Ana Reyes"),
        "channel.owner.email": pin("ana@example.test"),
    }
    base = StubShow(pins=pins, roster=(Person("Ana Reyes"),), media_url=TEMPLATE)
    return StubShow(**{**base.__dict__, **overrides}) if overrides else base


def make_project(tmp_path: Path, *, speakers: Sequence[str] = ("Ana Reyes",)) -> EpisodeProject:
    project = EpisodeProject.create("Nobody asked the river", str(tmp_path))
    project.tracks = [
        Track(id=f"t{i}", label=f"Track {i}", role=TrackRole.DIALOGUE, speaker=name)
        for i, name in enumerate(speakers)
    ]
    project.chapters = [
        ChapterMarker(time=0, title="Cold open"),
        ChapterMarker(time=312.4, title="The old mill"),
    ]
    project.feed.mint_identity(EXPORTED_AT)
    project.feed.guid = "urn:uuid:7c0e5a1e-4f3b-4a52-9d0e-6a1b2c3d4e5f"
    return project


def mp3(name: str = "nobody_asked_the_river.mp3", size: int = 49_920_000) -> ExportFile:
    return ExportFile(name=name, bytes=size)


def inputs(
    project: EpisodeProject,
    *,
    show: ShowProfile | None = None,
    shows: Sequence[ShowSummary] = (),
    files: ExportFiles | None = None,
) -> FeedInputs:
    return FeedInputs(
        project=project,
        show=show,
        shows=tuple(shows),
        files=files if files is not None else ExportFiles(audio=mp3()),
    )


def add_clip(project: EpisodeProject, start: float, end: float, title: str) -> None:
    project.social_clip_candidates = [
        SocialClipCandidate(
            id="c1", track_id="t0", start=start, end=end, title_suggestion=title, approved=True
        )
    ]


def with_transcript(project: EpisodeProject, language: str = "en") -> None:
    project.transcripts = [Transcript(track_id="t0", language=language)]
