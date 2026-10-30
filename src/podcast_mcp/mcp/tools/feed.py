"""Podcast listing tools: read the facts, notes and feed XML, pin or release a value, write the feed file."""

from __future__ import annotations

from typing import Annotated, Literal

from mcp.server import MCPServer
from pydantic import BeforeValidator

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService, FeedViewKind


def _text(value: object) -> object:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value) if isinstance(value, int | float) else value


def feed_read(
    project_path: str,
    view: Literal["facts", "item_xml", "feed_xml", "notes_html", "show"] = "facts",
) -> str:
    """Read the episode's podcast listing: every fact with where it came from, and what is missing.

    ``facts`` (default) is JSON: each value says whether it is derived, inherited, measured,
    minted, pinned (by a person or an agent, and whether the automatic value moved since) or
    pending with the edit that would fix it, plus findings tagged blocker, warn or info.
    ``notes_html`` is the show notes, ``item_xml`` the bare ``<item>``, ``feed_xml`` the feed
    file and ``show`` which show the episode belongs to. Use this before ``feed_set``. Not
    ``list_chapters_tool``: chapters are edited there, never in the listing.
    """
    kind: FeedViewKind = view
    result = FeedService(ProjectWorkspace.open(project_path)).present(kind)
    return result if isinstance(result, str) else to_json(result)


def feed_set(
    project_path: str,
    field: str,
    value: Annotated[str, BeforeValidator(_text)],
) -> str:
    """Pin one podcast-listing value for this episode, as an agent. Undoable with history.

    ``field`` is a key from ``feed_read``, such as ``item.intro``, ``item.title``,
    ``item.notes``, ``item.enclosure.url``, ``item.season`` or ``item.person[Name].href``.
    Write the episode intro with ``item.intro``: one or two sentences, plain text. Setting
    ``item.notes`` pins the whole notes text, so prefer ``item.intro``. Blank text
    unsets. ``value`` is text; a number or true/false is read as its text, so ``2`` and ``"2"`` both
    set season 2. Chapters, clips, speakers and transcripts are edited where they live, not here.
    Returns the updated facts. Not ``add_chapter_tool``.
    """
    view = FeedService(ProjectWorkspace.open(project_path)).set(field, value, "agent")
    return to_json(view.wire())


def feed_unset(project_path: str, field: str) -> str:
    """Drop this episode's pin on a listing value so it goes back to automatic.

    Also how to take the new automatic value after ``feed_read`` reports a pin whose
    source changed. Unsetting a field that holds no pin changes nothing. Undoable with history.
    """
    view = FeedService(ProjectWorkspace.open(project_path)).unset(field, "agent")
    return to_json(view.wire())


def feed_write(project_path: str) -> str:
    """Write the episode's feed file (``<name>.feed.xml``) next to its exported audio.

    Refused while ``feed_read`` shows a blocker, such as no show, no hosting address or no
    exported MP3. Idempotent: a second call with nothing changed writes nothing. The export
    job also writes it. Returns the path, the files written and the file state.
    """
    service = FeedService(ProjectWorkspace.open(project_path))
    result = service.write()
    return to_json(
        {
            "path": str(result.path),
            "written": [str(path) for path in result.written],
            "file": service.read().file,
        }
    )


def register(mcp: MCPServer) -> None:
    """Register the podcast listing tools on the MCP server."""
    for fn in (feed_read, feed_set, feed_unset, feed_write):
        mcp.tool()(fn)
