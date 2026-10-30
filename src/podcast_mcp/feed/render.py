"""The feed XML: a channel with this episode as its one item, built from a ``FeedView``.

An element appears only when its fact is known, so a missing address never shows up as a
placeholder. ``render(view, item_only=True)`` is the bare ``<item>`` for people who keep
their own feed.
"""

from __future__ import annotations

import re
import uuid
import xml.etree.ElementTree as ET
from email.utils import format_datetime

from podcast_mcp.feed.fields import FIELDS, FieldSpec, Tag, parse_moment
from podcast_mcp.feed.model import FeedView, Measured, Soundbite
from podcast_mcp.feed.notes import MEDIA_URL_KEY, NOTES_KEY
from podcast_mcp.feed.urls import (
    CHAPTERS_MIME,
    TRANSCRIPT_MIME,
    hosted_url,
    stem_of,
)

NAMESPACES = {
    "xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "xmlns:podcast": "https://podcastindex.org/namespace/1.0",
    "xmlns:atom": "http://www.w3.org/2005/Atom",
    "xmlns:content": "http://purl.org/rss/1.0/modules/content/",
}
_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'
_ILLEGAL = re.compile("[^\t\n\r -퟿-�\U00010000-\U0010ffff]")


def _clean(text: str) -> str:
    return _ILLEGAL.sub("", text)


def _number(value: float) -> str:
    rounded = round(value, 3)
    return str(int(rounded)) if rounded == int(rounded) else str(rounded)


class _Builder:
    def __init__(self) -> None:
        self._token = uuid.uuid4().hex
        self._cdata: list[str] = []

    def cdata(self, element: ET.Element, html: str) -> None:
        element.text = f"@@{self._token}:{len(self._cdata)}@@"
        self._cdata.append(html)

    def finish(self, xml: str) -> str:
        for index, html in enumerate(self._cdata):
            body = _clean(html).replace("]]>", "]]]]><![CDATA[>")
            xml = xml.replace(f"@@{self._token}:{index}@@", f"<![CDATA[{body}]]>")
        return xml


def _child(parent: ET.Element, name: str) -> ET.Element:
    """The child called ``name``, made on first use. A prefixed name is not an ElementPath."""
    for existing in parent:
        if existing.tag == name:
            return existing
    return ET.SubElement(parent, name)


def _node(parent: ET.Element, path: str) -> ET.Element:
    """The element at ``path`` below ``parent``; ``/`` nests and shares the parents."""
    *branch, leaf = path.split("/")
    for name in branch:
        parent = _child(parent, name)
    return ET.SubElement(parent, leaf)


def _text(value: object) -> str:
    return ("true" if value else "false") if isinstance(value, bool) else str(value)


def _rfc2822(iso: str) -> str | None:
    try:
        return format_datetime(parse_moment(iso), usegmt=True)
    except (ValueError, OverflowError):
        return None


def _put(parent: ET.Element, tag: Tag, value: object, build: _Builder, *, notes: bool) -> None:
    if tag.attr is not None:
        element = _child(parent, tag.path)
        element.set(tag.attr, _clean(_text(value)))
        for name, fixed in tag.fixed:
            element.set(name, fixed)
        return
    element = _node(parent, tag.path)
    for name, fixed in tag.fixed:
        element.set(name, fixed)
    if tag.cdata and notes:
        build.cdata(element, str(value))
    else:
        element.text = _clean(_text(value))


def _scalars(parent: ET.Element, view: FeedView, scope: str, build: _Builder) -> None:
    facts = view.channel if scope == "show" else view.item
    specs = [s for s in FIELDS if s.scope == scope and s.tags]
    if scope == "episode":
        specs.sort(key=lambda s: {"item.title": 0, NOTES_KEY: 1}.get(s.key, 2))
    for spec in specs:
        value = _value(spec, view, facts)
        if value in (None, ""):
            continue
        for tag in spec.tags:
            _put(parent, tag, value, build, notes=spec.key == NOTES_KEY)


def _value(spec: FieldSpec, view: FeedView, facts: dict) -> object:
    if spec.key == NOTES_KEY:
        return view.notes_html
    if spec.section == "art":
        return view.sections.art.value.src if view.sections.art.value else None
    if spec.section is not None:
        return None
    fact = facts.get(spec.key)
    value = None if fact is None else fact.value
    return _rfc2822(value) if spec.key == "item.pubDate" and value else value


def _hosting(view: FeedView) -> tuple[str, str] | None:
    template = view.channel.get(MEDIA_URL_KEY)
    audio = view.sections.audio.source
    if template is None or not isinstance(template.value, str) or not isinstance(audio, Measured):
        return None
    return template.value, stem_of(audio.file)


def _soundbite(parent: ET.Element, clip: Soundbite) -> None:
    element = ET.SubElement(parent, "podcast:soundbite")
    element.set("startTime", _number(clip.start))
    element.set("duration", _number(clip.end - clip.start))
    if clip.title:
        element.text = _clean(clip.title)


def _sections(item: ET.Element, view: FeedView) -> None:
    hosting = _hosting(view)
    sections = view.sections
    if hosting and sections.chapters.value:
        template, stem = hosting
        chapters = ET.SubElement(item, "podcast:chapters")
        chapters.set("url", hosted_url(template, f"{stem}.chapters.json"))
        chapters.set("type", CHAPTERS_MIME)
    if hosting:
        template, stem = hosting
        for transcript in sections.transcripts.value or []:
            element = ET.SubElement(item, "podcast:transcript")
            element.set("url", hosted_url(template, f"{stem}.{transcript.format.lower()}"))
            element.set("type", TRANSCRIPT_MIME[transcript.format])
            element.set("language", transcript.language)
    for person in sections.credits.value or []:
        element = ET.SubElement(item, "podcast:person")
        element.set("role", person.role)
        for name, attribute in (
            ("group", person.group),
            ("img", person.img),
            ("href", person.href),
        ):
            if attribute:
                element.set(name, _clean(attribute))
        element.text = _clean(person.name)
    for clip in sections.soundbites.value or []:
        _soundbite(item, clip)


def _item(view: FeedView, build: _Builder) -> ET.Element:
    item = ET.Element("item")
    _scalars(item, view, "episode", build)
    _sections(item, view)
    return item


def _serialize(element: ET.Element) -> str:
    ET.indent(element, space="  ")
    return ET.tostring(element, encoding="unicode").replace(" />", "/>")


def render(view: FeedView, *, item_only: bool = False) -> str:
    build = _Builder()
    item = _item(view, build)
    if item_only:
        return build.finish(_serialize(item)) + "\n"
    rss = ET.Element("rss", {"version": "2.0", **NAMESPACES})
    channel = ET.SubElement(rss, "channel")
    _scalars(channel, view, "show", build)
    channel.append(item)
    return _DECLARATION + build.finish(_serialize(rss)) + "\n"
