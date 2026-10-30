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
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from podcast_mcp.feed.fields import cover_file_name
from podcast_mcp.feed.inputs import feed_path, gather_inputs, show_art_source
from podcast_mcp.feed.model import FeedView, ShowSource, usable_ledger
from podcast_mcp.feed.render import render
from podcast_mcp.feed.resolve import resolve
from podcast_mcp.feed.show_store import ShowStore, default_directory
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_render import render_atomic_all
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import render_lock

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
    project: EpisodeProject,
    shows: ShowSource,
    *,
    now: datetime | None = None,
    persist: Callable[[], object] | None = None,
) -> FeedWrite:
    """Write the episode's feed file, minting its identity and number first when they are new.

    Under the project's render lock: the identity and the show link are made, ``persist``
    saves the project, the number is taken from the show's ledger, then the view that is
    rendered is checked once more for blockers before the artwork and the feed file are
    published. Nothing is published unless the identity is durable. If ``persist`` raises,
    ``project.feed`` is put back as it was. Raises ``CodedValueError`` (``feed_blocked``)
    while a blocker stands.
    """
    with render_lock(project):
        return _write_locked(project, shows, now, persist)


def _write_locked(
    project: EpisodeProject,
    shows: ShowSource,
    now: datetime | None,
    persist: Callable[[], object] | None,
) -> FeedWrite:
    first = gather_inputs(project, shows)
    refuse_while_blocked(resolve(first, project.feed.pins))
    before = project.feed.model_copy()
    project_changed = project.feed.mint_identity(now)
    if project.feed.show_id is None and first.show is not None:
        # The implicit single-show link would move if a second show were made.
        project.feed.show_id = first.show.id
        project_changed = True
    if project_changed and persist is not None:
        try:
            persist()
        except BaseException:
            project.feed.guid = before.guid
            project.feed.first_exported_at = before.first_exported_at
            project.feed.show_id = before.show_id
            raise
    identity_changed = project_changed
    if isinstance(shows, ShowStore) and first.show is not None and project.feed.guid:
        had = usable_ledger(first.show.ledger).get(project.feed.guid)
        pin = project.feed.pins.get("item.episode")
        pinned = pin.value if pin is not None and isinstance(pin.value, int) else None
        number = shows.number_for(first.show.id, project.feed.guid, pinned=pinned)
        identity_changed = identity_changed or number != had
    inputs = gather_inputs(project, shows)
    view = resolve(inputs, project.feed.pins)
    refuse_while_blocked(view)
    xml = render(view)
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

    # Artwork first: a crash between the two never leaves a feed pointing at missing art.
    paths = ([art_to] if art_to is not None else []) + [destination]

    def render_all(temps: list[Path]) -> None:
        temps[-1].write_text(xml, encoding="utf-8")
        if art_from is not None:
            shutil.copyfile(art_from, temps[0])

    written = render_atomic_all(paths, render_all)
    return FeedWrite(destination, tuple(written), identity_changed)


def _same_file(source: Path, copy: Path) -> bool:
    try:
        return copy.is_file() and filecmp.cmp(source, copy, shallow=False)
    except OSError:
        return False


def write_after_export(
    project: EpisodeProject,
    shows: ShowSource | None = None,
    *,
    persist: Callable[[], object] | None = None,
) -> FeedWrite | None:
    """Refresh the feed file once the audio has published; never let it fail the export.

    A blocker (no show yet, no hosting address) is the usual reason nothing is written. A
    file another program holds open, an unreadable show file or any other failure is logged
    and leaves the previous feed file, which then reads as stale until the next write.
    ``persist`` saves the project's new identity before the feed file is published.
    """
    try:
        return write_feed(project, shows or ShowStore(default_directory()), persist=persist)
    except CodedValueError as exc:
        log.info("feed file not written after export: %s", exc)
    except Exception:
        log.warning("feed file not written after export", exc_info=True)
    return None
