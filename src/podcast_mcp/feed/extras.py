"""The optional Podcasting 2.0 and Apple elements, each spelled by one short line of text.

A row of the registry (``fields.py``) keeps its value as the line a person types, such as
``https://example.test/give Support the show``. The row's ``shape`` reads that line into
an ``Element``: the attributes, text and children the feed carries. The same function
checks the line when it is set and builds the XML when the feed is rendered, so a pin that
was accepted always renders.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from email.utils import format_datetime
from pathlib import PurePosixPath
from typing import Any

from podcast_mcp.feed.urls import AUDIO_MIME, check_https_url

_MEDIA_TYPES = {
    **AUDIO_MIME,
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".m3u8": "application/x-mpegURL",
}
# The survey's limit for a short label such as a funding message or an update schedule.
TEXT_LIMIT = 128
DEFAULT_FUNDING_TEXT = "Support the show"
_UUID_EXAMPLE = "917393e3-1b1e-5cef-ace4-edaa54e1f810"


@dataclass(frozen=True)
class Child:
    path: str
    attrs: dict[str, str] = field(default_factory=dict)
    text: str | None = None


@dataclass(frozen=True)
class Element:
    """What one feed element carries beyond its name: attributes, text and child elements."""

    attrs: dict[str, str] = field(default_factory=dict)
    text: str | None = None
    children: tuple[Child, ...] = ()


Shape = Callable[[Any], Element]


def _words(value: Any, usage: str, *, low: int, high: int | None = None) -> list[str]:
    """The words of ``value``; the last allowed word keeps the rest of the line."""
    if not isinstance(value, str):
        raise ValueError(f"must be text such as {usage}")
    parts = value.split(None, (high - 1) if high else -1)
    if len(parts) < low or (high is not None and len(parts) > high):
        raise ValueError(f"must look like {usage}")
    return parts


def _https(address: str) -> str:
    try:
        return check_https_url(address)
    except ValueError as exc:
        raise ValueError(
            f"{address!r} must be an https address with ASCII characters only"
        ) from exc


_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_NODE_ADDRESS = re.compile(r"[0-9a-fA-F]{8,128}")


def _guid(word: str) -> str:
    if not _UUID.fullmatch(word):
        raise ValueError(f"{word!r} is not a feed guid, which looks like {_UUID_EXAMPLE}")
    return word


def _short(text: str, what: str) -> str:
    if len(text) >= TEXT_LIMIT:
        raise ValueError(f"{what} must be under {TEXT_LIMIT} characters")
    return text


def yes_only(value: Any) -> bool:
    """Apple and Podcasting 2.0 flags exist only as "yes"; taking one away is an unset."""
    if value is True or (isinstance(value, str) and value.strip().lower() in {"yes", "true"}):
        return True
    raise ValueError("can only be yes; use unset to remove it")


def locked(value: Any) -> Element:
    return Element(text="yes" if _bool(value) else "no")


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"yes", "true"}:
        return True
    if text in {"no", "false"}:
        return False
    raise ValueError("must be yes or no")


def flag(value: Any) -> Element:
    yes_only(value)
    return Element(text="Yes")


def funding(value: Any) -> Element:
    url, *rest = _words(value, "https://example.test/give [message]", low=1, high=2)
    message = _short(rest[0], "the message") if rest else DEFAULT_FUNDING_TEXT
    return Element(attrs={"url": _https(url)}, text=message)


def license_(value: Any) -> Element:
    name, *rest = _words(value, "cc-by-4.0 [https://example.test/license]", low=1, high=2)
    return Element(attrs={"url": _https(rest[0])} if rest else {}, text=name)


def social_interact(value: Any) -> Element:
    protocol, uri, *rest = _words(
        value, "activitypub https://example.test/@show/1 [@show@example.test]", low=2, high=3
    )
    attrs = {"protocol": protocol, "uri": _https(uri)}
    if rest:
        attrs["accountId"] = rest[0]
    return Element(attrs=attrs)


def chat(value: Any) -> Element:
    protocol, server, *rest = _words(value, "irc irc.example.test [space]", low=2, high=3)
    attrs = {"protocol": protocol, "server": server}
    if rest:
        attrs["space"] = rest[0]
    return Element(attrs=attrs)


def value_node(value: Any) -> Element:
    address, *rest = _words(value, "02ab...node-address [name]", low=1, high=2)
    if not _NODE_ADDRESS.fullmatch(address):
        raise ValueError(f"{address!r} must be a node public key in hexadecimal")
    recipient = {"type": "node", "address": address, "split": "100"}
    if rest:
        recipient["name"] = rest[0]
    return Element(
        attrs={"type": "lightning", "method": "keysend"},
        children=(Child("podcast:valueRecipient", recipient),),
    )


def remote_item_attrs(value: Any, usage: str, second: str) -> dict[str, str]:
    guid, *rest = _words(value, usage, low=1, high=2)
    attrs = {"feedGuid": _guid(guid)}
    if rest:
        attrs[second] = _https(rest[0]) if second == "feedUrl" else _guid(rest[0])
    return attrs


def remote_item(value: Any) -> Element:
    return Element(attrs=remote_item_attrs(value, "feed-guid [item-guid]", "itemGuid"))


def publisher(value: Any) -> Element:
    attrs = remote_item_attrs(value, "feed-guid [https://example.test/feed.xml]", "feedUrl")
    return Element(children=(Child("podcast:remoteItem", {**attrs, "medium": "publisher"}),))


def podroll(value: Any) -> Element:
    lines = [line.strip() for line in str(value).splitlines() if line.strip()]
    if not lines:
        raise ValueError(
            "must list one feed per line, as feed-guid [https://example.test/feed.xml]"
        )
    return Element(
        children=tuple(
            Child(
                "podcast:remoteItem",
                remote_item_attrs(line, "feed-guid [https://example.test/feed.xml]", "feedUrl"),
            )
            for line in lines
        )
    )


def trailer(value: Any) -> Element:
    url, when, *title = _words(
        value, "https://example.test/trailer.mp3 2026-11-01T09:00:00Z Trailer title", low=3, high=3
    )
    try:
        moment = datetime.fromisoformat(when.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{when!r} must be an ISO 8601 time such as 2026-11-01T09:00:00Z") from exc
    if moment.tzinfo is None:
        raise ValueError(f"{when!r} needs a time zone, such as Z")
    attrs = {"pubdate": format_datetime(moment, usegmt=True), "url": _https(url)}
    if kind := _MEDIA_TYPES.get(PurePosixPath(url).suffix.lower()):
        attrs["type"] = kind
    return Element(attrs=attrs, text=title[0])


def alternate_enclosure(value: Any) -> Element:
    url, *rest = _words(value, "https://example.test/ep.ogg [audio/ogg]", low=1, high=2)
    kind = rest[0] if rest else _MEDIA_TYPES.get(PurePosixPath(url).suffix.lower())
    if kind is None:
        raise ValueError("needs a media type when the address does not end in a known extension")
    return Element(attrs={"type": kind}, children=(Child("podcast:source", {"uri": _https(url)}),))


def plain(value: Any) -> Element:
    text = str(value).strip()
    if not text:
        raise ValueError("must not be empty")
    return Element(text=text)


def short(value: Any) -> Element:
    element = plain(value)
    _short(element.text or "", "the text")
    return element


def checked(shape: Shape) -> Callable[[Any], Any]:
    """A validator that accepts exactly what ``shape`` can render and keeps the value as typed."""

    def check(value: Any) -> Any:
        shape(value)
        return value

    return check
