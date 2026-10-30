"""Write the feed file: the one place a listing leaves the project and lands in ``export/``.

``write_feed`` refuses while a blocker stands, gives the episode its guid and first export
time once, takes the episode's number from the show's ledger once, then publishes
``<stem>.feed.xml`` and a copy of the show's artwork file together. Writing again with
nothing changed touches no file.
"""

from __future__ import annotations

import filecmp
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from podcast_mcp.feed.fields import cover_file_name
from podcast_mcp.feed.inputs import feed_path, gather_inputs, show_art_source
from podcast_mcp.feed.model import FeedView, ShowSource
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import resolve
from podcast_mcp.feed.show_store import ShowStore, default_directory
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_render import render_atomic_all
from podcast_mcp.util.coded_error import CodedValueError

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class FeedWrite:
    path: Path
    # The files published by this call; empty when the feed and artwork were already current.
    written: tuple[Path, ...]
    # Whether the call gave the project an identity or the show a number, so the project needs saving.
    identity_changed: bool


def blockers(view: FeedView) -> list[str]:
    return [f.message for f in view.findings if f.severity == "blocker"]


def refuse_while_blocked(view: FeedView) -> None:
    if found := blockers(view):
        raise CodedValueError(
            "The feed cannot be written yet: " + " ".join(found), code="feed_blocked"
        )


def write_feed(
    project: EpisodeProject, shows: ShowSource, *, now: datetime | None = None
) -> FeedWrite:
    """Write the episode's feed file, minting its identity and number first when they are new.

    ``project.feed`` is changed in place when the identity is new; the caller saves the
    project. Raises ``CodedValueError`` (``feed_blocked``) while a blocker stands.
    """
    refuse_while_blocked(resolve(gather_inputs(project, shows), project.feed.pins))
    identity_changed = project.feed.mint_identity(now)
    first = gather_inputs(project, shows)
    if isinstance(shows, ShowStore) and first.show is not None and project.feed.guid:
        had = project.feed.guid in first.show.ledger
        shows.number_for(first.show.id, project.feed.guid)
        identity_changed = identity_changed or not had
    inputs = gather_inputs(project, shows)
    xml = render(resolve(inputs, project.feed.pins))
    destination = feed_path(project)
    art_from = show_art_source(inputs.show) if inputs.show_art is not None else None
    art_to = (
        destination.with_name(cover_file_name(project.name, str(art_from)))
        if art_from is not None
        else None
    )
    current = inputs.files.feed_xml == xml and (
        art_to is None or (art_from is not None and _same_file(art_from, art_to))
    )
    if current:
        return FeedWrite(destination, (), identity_changed)

    paths = [destination] + ([art_to] if art_to is not None else [])

    def render_all(temps: list[Path]) -> None:
        temps[0].write_text(xml, encoding="utf-8")
        if art_from is not None:
            shutil.copyfile(art_from, temps[1])

    written = render_atomic_all(paths, render_all)
    return FeedWrite(destination, tuple(written), identity_changed)


def _same_file(source: Path, copy: Path) -> bool:
    try:
        return copy.is_file() and filecmp.cmp(source, copy, shallow=False)
    except OSError:
        return False


def write_after_export(
    project: EpisodeProject, shows: ShowSource | None = None
) -> FeedWrite | None:
    """Refresh the feed file once the audio has published; never let it fail the export.

    A blocker (no show yet, no hosting address) is the usual reason nothing is written. A
    file another program holds open, an unreadable show file or any other failure is logged
    and leaves the previous feed file, which then reads as stale until the next write.
    """
    try:
        return write_feed(project, shows or ShowStore(default_directory()))
    except CodedValueError as exc:
        log.info("feed file not written after export: %s", exc)
    except Exception:
        log.warning("feed file not written after export", exc_info=True)
    return None
