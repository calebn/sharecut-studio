"""Gather what a listing is resolved from: the project, its show and the files on disk."""

from __future__ import annotations

import wave
from collections.abc import Sequence
from pathlib import Path

from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.feed.model import (
    ExportFile,
    ExportFiles,
    FeedInputs,
    ShowId,
    ShowProfile,
    ShowSource,
    ShowSummary,
)
from podcast_mcp.feed.show_store import ShowStore
from podcast_mcp.feed.urls import is_local_art
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.wav import open_wav

FEED_AUDIO_EXTENSIONS = ("mp3", "m4a")
TRANSCRIPT_EXTENSIONS = ("vtt", "srt")
ART_KEY = "channel.image"


def _file(path: Path) -> ExportFile | None:
    try:
        return ExportFile(name=path.name, bytes=path.stat().st_size) if path.is_file() else None
    except OSError:
        return None


def _wav_seconds(path: Path) -> float | None:
    try:
        with open_wav(path) as reader:
            return reader.getnframes() / reader.getframerate()
    except (wave.Error, EOFError, OSError, ZeroDivisionError):
        return None


def feed_path(project: EpisodeProject) -> Path:
    """Where this episode's feed file lives: ``<export>/<stem>.feed.xml``."""
    return project.export_dir() / f"{sanitize_export_stem(project.name)}.feed.xml"


def export_files(project: EpisodeProject) -> ExportFiles:
    """What the export directory holds for this episode, found by the export's own file names."""
    directory = project.export_dir()
    stem = sanitize_export_stem(project.name)

    def named(extension: str) -> ExportFile | None:
        return _file(directory / f"{stem}.{extension}")

    audio = next((f for ext in FEED_AUDIO_EXTENSIONS if (f := named(ext))), None)
    wav = named("wav")
    if wav is not None:
        wav = ExportFile(name=wav.name, bytes=wav.bytes, seconds=_wav_seconds(directory / wav.name))
    feed = feed_path(project)
    try:
        feed_xml = feed.read_text(encoding="utf-8", errors="replace") if feed.is_file() else None
    except OSError:
        feed_xml = ""
    return ExportFiles(
        audio=audio,
        wav=wav,
        transcripts=tuple(f for ext in TRANSCRIPT_EXTENSIONS if (f := named(ext))),
        feed_xml=feed_xml,
    )


def show_art_source(show: ShowProfile | None) -> Path | None:
    """The artwork file on this machine that the show names, or None for an address or no art."""
    pin = show.pins.get(ART_KEY) if show else None
    if pin is None or not isinstance(pin.value, str) or not is_local_art(pin.value):
        return None
    return Path(pin.value)


def linked_show_id(project: EpisodeProject, summaries: Sequence[ShowSummary]) -> ShowId | None:
    """The episode's show: the one it is linked to, else the only show on the machine."""
    return project.feed.show_id or (summaries[0].id if len(summaries) == 1 else None)


def gather_inputs(project: EpisodeProject, shows: ShowSource) -> FeedInputs:
    summaries = tuple(shows.shows())
    problems = list(shows.problems()) if isinstance(shows, ShowStore) else []
    show_id = linked_show_id(project, summaries)
    profile = None
    unreadable = None
    if show_id:
        try:
            profile = shows.profile(show_id)
        except CodedValueError as exc:
            if exc.code != "feed_show_unreadable":
                raise
            unreadable = str(exc)
            problems.append(unreadable)
    art = show_art_source(profile)
    return FeedInputs(
        project=project,
        show=profile,
        shows=summaries,
        files=export_files(project),
        show_art=_file(art) if art else None,
        show_problems=tuple(dict.fromkeys(problems)),
        show_unreadable=unreadable,
    )
