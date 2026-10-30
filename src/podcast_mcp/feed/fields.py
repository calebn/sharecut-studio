"""FIELDS: the one list of listing rows.

A row says where a fact comes from, how it is edited, which feed tags carry it and what
to check. The resolver, the XML renderer, the CLI help, the MCP schema and the docs table
all read this list, so adding a tag is adding a row and touches no adapter.

Rows resolve in list order, so a row may read any row above it through ``Resolution``.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BeforeValidator, StringConstraints, TypeAdapter

from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.feed import extras
from podcast_mcp.feed.model import (
    Art,
    AudioFile,
    CommandFix,
    Credit,
    Derived,
    FeedChapter,
    FeedInputs,
    Finding,
    Fix,
    InputFix,
    Measured,
    Minted,
    Resolved,
    Severity,
    ShowProfile,
    Soundbite,
    Transcript,
    inherited,
    usable_ledger,
)
from podcast_mcp.feed.notes import NotesParts, compose_notes, transcript_href
from podcast_mcp.feed.urls import (
    art_extension,
    audio_mime,
    check_art_ref,
    check_https_url,
    check_media_template,
    hosted_url,
    is_local_art,
    podcast_guid,
    stem_of,
)
from podcast_mcp.models import TrackRole
from podcast_mcp.models.feed import Pin


@dataclass(frozen=True)
class Found:
    value: Any
    source: Resolved


@dataclass(frozen=True)
class Missing:
    why: str
    fix: Fix | None = None


Auto = Found | Missing


@dataclass
class Resolution:
    """The rows resolved so far, handed to each row's ``derive`` and ``checks``."""

    inputs: FeedInputs
    pins: Mapping[str, Pin]
    facts: dict[str, Auto] = field(default_factory=dict)
    # Pinned rows whose stored value is not the kind of value the row takes (a hand edit).
    unusable_pins: set[str] = field(default_factory=set)

    @property
    def show(self) -> ShowProfile | None:
        return self.inputs.show

    def value(self, key: str) -> Any:
        fact = self.facts.get(key)
        return fact.value if isinstance(fact, Found) else None

    @property
    def media_template(self) -> str | None:
        template = self.value("channel.mediaUrl")
        return template if isinstance(template, str) else None


@dataclass(frozen=True)
class AtSource:
    """A row edited where its source lives, never in the listing."""

    owner: Literal["chapters", "clips", "speakers", "transcript", "roster"]
    where: str


Edit = Literal["pin", "mint", "none"] | AtSource


@dataclass(frozen=True)
class Tag:
    """A feed tag a row feeds. ``path`` may nest with ``/``; ``attr`` makes the value an attribute."""

    path: str
    attr: str | None = None
    fixed: tuple[tuple[str, str], ...] = ()
    cdata: bool = False
    # Reads the value into the element's attributes, text and children (``extras.py``).
    shape: extras.Shape | None = None


@dataclass(frozen=True)
class Need:
    """What a missing row costs. ``message`` defaults to the row's own reason."""

    severity: Severity
    platform: str | None
    message: str | None = None


Check = Callable[["Resolution", Found], Iterable[Finding]]


@dataclass(frozen=True)
class FieldSpec:
    key: str
    scope: Literal["show", "episode"]
    label: str
    help: str
    value: TypeAdapter[Any]
    edit: Edit
    tags: tuple[Tag, ...] = ()
    derive: Callable[[Resolution], Auto] | None = None
    inherit: str | None = None
    section: Literal["art", "audio", "chapters", "credits", "transcripts", "soundbites"] | None = (
        None
    )
    missing: str = ""
    ask: bool = True
    listed: Literal["always", "known", "pinned"] = "always"
    needs: Need | None = None
    checks: tuple[Check, ...] = ()
    drift_hint: str | None = None
    pin_shape: Callable[[Resolution, Any], Any] | None = None
    # Turns a pinned value into the fact it stands for, which may be pending (hosting not known yet).
    pin_resolve: Callable[[Resolution, Any], Auto] | None = None
    # Where files live is the host's to say: a share link never pins this row.
    host_only: bool = False


Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
Https = Annotated[str, AfterValidator(check_https_url)]
ArtRef = Annotated[str, AfterValidator(check_art_ref)]
Template = Annotated[str, AfterValidator(check_media_template)]
Email = Annotated[str, StringConstraints(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)]
Language = Annotated[str, StringConstraints(pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")]

_TEXT = TypeAdapter(Text)
_BOOL = TypeAdapter(bool)


MAX_NUMBER = 999_999
NAME_MAX = 128


def _count(value: int) -> int:
    if not 1 <= value <= MAX_NUMBER:
        raise ValueError(f"must be between 1 and {MAX_NUMBER}")
    return value


def _not_bool(value: Any) -> Any:
    if isinstance(value, bool):
        raise ValueError("must be a whole number")
    return value


_NUMBER = TypeAdapter(Annotated[int, BeforeValidator(_not_bool), AfterValidator(_count)])
_EPISODE_TYPE = TypeAdapter(Literal["full", "trailer", "bonus"])


def iso_z(moment: datetime) -> str:
    aware = moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    return aware.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_moment(value: str) -> datetime:
    """An ISO 8601 date or time as UTC: a bare time is UTC and a bare date is midnight UTC."""
    moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    return (moment if moment.tzinfo else moment.replace(tzinfo=UTC)).astimezone(UTC)


def _check_iso(value: str) -> str:
    try:
        return iso_z(parse_moment(value))
    except (ValueError, OverflowError):
        raise ValueError("must be an ISO 8601 date or time") from None


_MOMENT = TypeAdapter(Annotated[str, AfterValidator(_check_iso)])

EXPORT = CommandFix(command="export_episode")
_CHOOSE_ART = CommandFix(command="choose_art")


def _title(res: Resolution) -> Auto:
    name = res.inputs.project.name.strip()
    if not name:
        return Missing("The episode needs a name.", InputFix(key="item.title"))
    return Found(name, Derived(rule="the project name"))


def _pub_date(res: Resolution) -> Auto:
    first = res.inputs.project.feed.first_exported_at
    if first is None:
        return Missing("Set when you export.", EXPORT)
    return Found(iso_z(parse_moment(first)), Derived(rule="the first export"))


def _guid(res: Resolution) -> Auto:
    feed = res.inputs.project.feed
    if not feed.guid:
        return Missing("Created when you write the feed file.", None)
    at = iso_z(parse_moment(feed.first_exported_at)) if feed.first_exported_at else ""
    return Found(feed.guid, Minted(at=at))


def _audio_missing(res: Resolution) -> Missing:
    if res.inputs.files.wav is not None:
        return Missing("Only a WAV was exported. Hosts need an MP3 or M4A.", EXPORT)
    return Missing("Size and length come from the export.", EXPORT)


def _enclosure_url(res: Resolution) -> Auto:
    template = res.media_template
    if template is None:
        return Missing("Where will this be hosted?", InputFix(key="item.enclosure.url"))
    audio = res.inputs.files.audio
    if audio is None:
        return _audio_missing(res)
    return Found(
        hosted_url(template, audio.name), Derived(rule="the hosting address and the export")
    )


def _enclosure_length(res: Resolution) -> Auto:
    audio = res.inputs.files.audio
    if audio is None:
        return _audio_missing(res)
    return Found(audio.bytes, Measured(file=audio.name))


def _enclosure_type(res: Resolution) -> Auto:
    audio = res.inputs.files.audio
    mime = audio_mime(audio.name) if audio else None
    if mime is None:
        return _audio_missing(res)
    return Found(mime, Derived(rule="the audio format"))


def _duration(res: Resolution) -> Auto:
    wav = res.inputs.files.wav
    if wav is None or wav.seconds is None:
        return Missing("Measured from the export.", None)
    return Found(round(wav.seconds), Measured(file=wav.name))


def _episode_type(_: Resolution) -> Auto:
    return Found("full", Derived(rule="the default"))


def _art(res: Resolution) -> Auto:
    src = res.value("channel.image")
    if not isinstance(src, str):
        return Missing("Artwork comes from your show.", _CHOOSE_ART)
    return Found(_art_for(res, src), inherited("channel.image"))


def _art_for(res: Resolution, src: str) -> Art:
    show = res.value("channel.title")
    return Art(src=src, alt=f"{show} cover art" if isinstance(show, str) else "Cover art")


def _audio(res: Resolution) -> Auto:
    audio = res.inputs.files.audio
    mime = audio_mime(audio.name) if audio else None
    if audio is None or mime is None:
        return _audio_missing(res)
    return Found(AudioFile(mime=mime, bytes=audio.bytes), Measured(file=audio.name))


def _plural(count: int, noun: str) -> str:
    return "none" if count == 0 else f"{count} {noun}{'' if count == 1 else 's'}"


def _chapters(res: Resolution) -> Auto:
    marks = sorted(res.inputs.project.chapters, key=lambda c: c.time)
    chapters = [FeedChapter(at=c.time, title=c.title) for c in marks]
    return Found(chapters, Derived(rule=_plural(len(chapters), "chapter")))


def _transcripts(res: Resolution) -> Auto:
    project = res.inputs.project
    language = project.transcripts[0].language if project.transcripts else "en"
    found = [
        Transcript(format="VTT" if file.name.lower().endswith(".vtt") else "SRT", language=language)
        for file in res.inputs.files.transcripts
    ]
    rule = "the exported transcripts" if found else "none"
    return Found(found, Derived(rule=rule))


def _soundbites(res: Resolution) -> Auto:
    clips = [
        Soundbite(title=(c.title_suggestion or "")[:NAME_MAX], start=c.start, end=c.end)
        for c in res.inputs.project.social_clip_candidates
        if c.approved
    ]
    return Found(clips, Derived(rule=_plural(len(clips), "approved clip")))


PERSON_ATTRS = ("role", "group", "img", "href", "exclude")
PERSON_KEY = re.compile(
    r"^item\.person\[(?P<name>.+)\]\.(?P<attr>" + "|".join(PERSON_ATTRS) + ")$", re.DOTALL
)


def person_key(name: str, attr: str) -> str:
    return f"item.person[{name}].{attr}"


def _roster(res: Resolution) -> dict[str, Any]:
    return {p.name.casefold(): p for p in (res.show.roster if res.show else ())}


def speakers(res: Resolution) -> list[str]:
    seen: dict[str, str] = {}
    for track in res.inputs.project.tracks:
        name = (track.speaker or "").strip()
        if track.role is TrackRole.DIALOGUE and name:
            seen.setdefault(name.casefold(), name)
    return list(seen.values())


def _credits(res: Resolution) -> Auto:
    roster = _roster(res)
    people: list[Credit] = []
    for name in speakers(res):
        listed = roster.get(name.casefold())
        base = {
            "role": listed.role if listed else "guest",
            "group": listed.group if listed else "cast",
            "img": listed.img if listed else None,
            "href": listed.href if listed else None,
        }
        pinned = {a: p.value for a in base if (p := res.pins.get(person_key(name, a)))}
        if (out := res.pins.get(person_key(name, "exclude"))) and out.value is True:
            continue
        merged = {**base, **pinned}
        people.append(
            Credit(
                name=name,
                role=str(merged["role"]),
                group=None if merged["group"] == "cast" else str(merged["group"]),
                img=merged["img"] if isinstance(merged["img"], str) else None,
                href=merged["href"] if isinstance(merged["href"], str) else None,
            )
        )
    return Found(people, Derived(rule=_plural(len(people), "speaker")))


def _unmatched_guests(res: Resolution, found: Found) -> Iterable[Finding]:
    roster = _roster(res)
    for credit in found.value:
        if credit.name.casefold() in roster or person_key(credit.name, "role") in res.pins:
            continue
        key = person_key(credit.name, "role")
        yield Finding(
            key=key,
            severity="warn",
            platform="Podcasting 2.0",
            message=f"{credit.name} is not on your show's host list, so they are listed as a guest.",
            fix=None,
        )


def _soundbite_lengths(_: Resolution, found: Found) -> Iterable[Finding]:
    for clip in found.value:
        if not 15 <= clip.end - clip.start <= 120:
            yield Finding(
                key="item.soundbite",
                severity="warn",
                platform="Podcasting 2.0",
                message=f"The soundbite “{clip.title}” is outside the 15 to 120 seconds apps expect.",
                fix=None,
            )


def _long_title(_: Resolution, found: Found) -> Iterable[Finding]:
    if len(found.value) > 100:
        yield Finding(
            key="item.title",
            severity="info",
            platform="Spotify",
            message="Spotify shows only the first 100 characters of a title.",
            fix=None,
        )


def _long_description(_: Resolution, found: Found) -> Iterable[Finding]:
    if len(found.value.encode()) > 4000:
        yield Finding(
            key="channel.description",
            severity="warn",
            platform="Apple",
            message="Apple reads at most 4000 bytes of the show description.",
            fix=None,
        )


def _long_chapter_titles(_: Resolution, found: Found) -> Iterable[Finding]:
    if any(len(c.title) >= 45 for c in found.value):
        yield Finding(
            key="item.chapters",
            severity="info",
            platform="Apple",
            message="Apple suggests chapter titles under 45 characters.",
            fix=None,
        )


def _notes_parts(res: Resolution) -> NotesParts:
    audio = res.inputs.files.audio
    intro = res.value("item.intro")
    return NotesParts(
        intro=intro if isinstance(intro, str) else None,
        chapters=res.value("item.chapters") or (),
        credits=res.value("item.person") or (),
        transcript_href=transcript_href(
            res.media_template, audio.name if audio else None, res.value("item.transcript") or ()
        ),
    )


def _notes(res: Resolution) -> Auto:
    return Found(compose_notes(_notes_parts(res)), Derived(rule="the intro, chapters and credits"))


def _language(res: Resolution) -> Auto:
    transcripts = res.inputs.project.transcripts
    if not transcripts:
        return Missing("Set once for the show.", InputFix(key="channel.language"))
    return Found(transcripts[0].language, Derived(rule="the transcript language"))


def _media_url(res: Resolution) -> Auto:
    template = res.show.media_url if res.show else None
    if template is None:
        return Missing("Where will this be hosted?", InputFix(key="channel.mediaUrl"))
    return Found(template, Derived(rule="the show's hosting address"))


def _feed_url(res: Resolution) -> Auto:
    audio = res.inputs.files.audio
    if res.media_template is None or audio is None:
        return Missing("The feed address needs the hosting address and an export.", None)
    return Found(
        hosted_url(res.media_template, f"{stem_of(audio.name)}.feed.xml"),
        Derived(rule="the hosting address"),
    )


def cover_file_name(project_name: str, source: str) -> str:
    """The name the show's artwork file takes in this episode's export set."""
    return f"{sanitize_export_stem(project_name)}.cover{art_extension(source)}"


def _channel_image(res: Resolution, value: str) -> Auto:
    """Show artwork named by an address stands as is; a file here is hosted beside the audio."""
    if not is_local_art(value):
        return Found(value, Derived(rule="the address"))
    if res.inputs.show_art is None:
        return Missing(f"The artwork file {Path(value).name} is missing.", _CHOOSE_ART)
    template = res.show.media_url if res.show else None
    if template is None:
        return Missing("Where will this be hosted?", InputFix(key="channel.mediaUrl"))
    name = cover_file_name(res.inputs.project.name, value)
    return Found(
        hosted_url(template, name), Derived(rule="the artwork file and the hosting address")
    )


def _roster_names(res: Resolution) -> Auto:
    roster = res.show.roster if res.show else ()
    if not roster:
        return Missing("Add the people who host the show.", None)
    return Found([f"{p.name} ({p.role})" for p in roster], Derived(rule="the show's host list"))


def _episode_number(res: Resolution) -> Auto:
    guid = res.inputs.project.feed.guid
    number = usable_ledger(res.show.ledger).get(guid) if res.show and guid else None
    if number is None:
        return Missing("Numbered when the feed file is first written.", None)
    return Found(number, Derived(rule="the show's episode count"))


def _podcast_guid(res: Resolution) -> Auto:
    url = res.value("channel.feedUrl")
    if not isinstance(url, str):
        return Missing("Made from the feed address.", None)
    return Found(podcast_guid(url), Derived(rule="the feed address"))


def _show(
    key: str,
    label: str,
    help_: str,
    value: TypeAdapter[Any],
    *tags: Tag,
    needs: Need | None = None,
    derive: Callable[[Resolution], Auto] | None = None,
    checks: tuple[Check, ...] = (),
    missing: str = "Set once for the show.",
    edit: Edit = "pin",
    listed: Literal["always", "known", "pinned"] = "always",
    pin_resolve: Callable[[Resolution, Any], Auto] | None = None,
    host_only: bool = False,
) -> FieldSpec:
    return FieldSpec(
        key=key,
        scope="show",
        label=label,
        help=help_,
        value=value,
        edit=edit,
        tags=tags,
        derive=derive,
        missing=missing,
        needs=needs,
        checks=checks,
        listed=listed,
        pin_resolve=pin_resolve,
        host_only=host_only,
    )


def _optional(
    scope: Literal["show", "episode"],
    name: str,
    label: str,
    help_: str,
    usage: str,
    path: str,
    shape: extras.Shape,
    *,
    value: TypeAdapter[Any] | None = None,
    checks: tuple[Check, ...] = (),
) -> FieldSpec:
    """An optional namespace row: absent unless pinned, and a pin renders exactly as it was checked."""
    prefix = "channel" if scope == "show" else "item"
    adapter = value or TypeAdapter(Annotated[str, AfterValidator(extras.checked(shape))])
    return FieldSpec(
        key=f"{prefix}.{name}",
        scope=scope,
        label=label,
        help=f"{help_} Written as {usage}." if usage else help_,
        value=adapter,
        edit="pin",
        tags=(Tag(path, shape=shape),),
        listed="known",
        missing="Optional.",
        checks=checks,
    )


def _yes_only() -> TypeAdapter[Any]:
    return TypeAdapter(Annotated[bool, AfterValidator(extras.yes_only)])


def _advice(key: str, message: str, platform: str) -> Check:
    def check(_: Resolution, found: Found) -> Iterable[Finding]:
        yield Finding(key=key, severity="info", platform=platform, message=message, fix=None)

    return check


def _optional_rows() -> tuple[FieldSpec, ...]:
    """Slice 5 of the feed: the rest of the Apple and Podcasting 2.0 elements, all optional."""
    show: Literal["show"] = "show"
    episode: Literal["episode"] = "episode"
    rows = [
        _optional(
            show,
            "locked",
            "locked",
            "Whether other hosts may import this feed.",
            "yes or no",
            "podcast:locked",
            extras.locked,
            value=TypeAdapter(bool),
        ),
        _optional(
            show,
            "type",
            "show type",
            "episodic (newest first) or serial (oldest first).",
            "episodic or serial",
            "itunes:type",
            extras.plain,
            value=TypeAdapter(Literal["episodic", "serial"]),
        ),
        _optional(
            show,
            "block",
            "hidden from Apple",
            "Keeps the show out of Apple Podcasts.",
            "yes",
            "itunes:block",
            extras.flag,
            value=_yes_only(),
            checks=(
                _advice(
                    "channel.block", "Apple Podcasts hides the show while this is on.", "Apple"
                ),
            ),
        ),
        _optional(
            show,
            "complete",
            "finished",
            "Says the show will have no more episodes.",
            "yes",
            "itunes:complete",
            extras.flag,
            value=_yes_only(),
            checks=(
                _advice(
                    "channel.complete",
                    "Apple stops looking for new episodes of a finished show.",
                    "Apple",
                ),
            ),
        ),
        _optional(
            show,
            "newFeedUrl",
            "new feed address",
            "Where the show's feed has moved to.",
            "https://example.test/feed.xml",
            "itunes:new-feed-url",
            extras.plain,
            value=TypeAdapter(Https),
            checks=(
                _advice(
                    "channel.newFeedUrl",
                    "Apps move listeners to the new address. Keep this feed up for a few weeks.",
                    "Apple",
                ),
            ),
        ),
        _optional(
            show,
            "medium",
            "medium",
            "What the show is: podcast, music, video, film, audiobook, newsletter or blog.",
            "podcast",
            "podcast:medium",
            extras.plain,
            value=TypeAdapter(
                Literal["podcast", "music", "video", "film", "audiobook", "newsletter", "blog"]
            ),
        ),
        _optional(
            show,
            "updateFrequency",
            "update schedule",
            "How often new episodes come, in your words.",
            "Weekly",
            "podcast:updateFrequency",
            extras.short,
        ),
        _optional(
            show,
            "trailer",
            "trailer",
            "A short preview of the show.",
            "https://example.test/trailer.mp3 2026-11-01T09:00:00Z Trailer title",
            "podcast:trailer",
            extras.trailer,
        ),
        _optional(
            show,
            "podroll",
            "recommended shows",
            "Shows you recommend, one feed per line.",
            "feed-guid [https://example.test/feed.xml]",
            "podcast:podroll",
            extras.podroll,
        ),
        _optional(
            show,
            "publisher",
            "publisher",
            "The company that publishes this show.",
            "feed-guid [https://example.test/feed.xml]",
            "podcast:publisher",
            extras.publisher,
        ),
    ]
    scopes: tuple[Literal["show", "episode"], ...] = (show, episode)
    for scope in scopes:
        rows += [
            _optional(
                scope,
                "funding",
                "funding link",
                "Where listeners can give money.",
                "https://example.test/give [message]",
                "podcast:funding",
                extras.funding,
            ),
            _optional(
                scope,
                "license",
                "license",
                "The license the content is under.",
                "cc-by-4.0 [https://example.test/license]",
                "podcast:license",
                extras.license_,
            ),
            _optional(
                scope,
                "location",
                "location",
                "The place the content is about.",
                "",
                "podcast:location",
                extras.plain,
                value=_TEXT,
            ),
            _optional(
                scope,
                "txt",
                "note for apps",
                "A short text note for apps and hosts.",
                "",
                "podcast:txt",
                extras.plain,
                value=_TEXT,
            ),
            _optional(
                scope,
                "socialInteract",
                "social thread",
                "The post listeners reply to.",
                "activitypub https://example.test/@show/1 [@show@example.test]",
                "podcast:socialInteract",
                extras.social_interact,
            ),
            _optional(
                scope,
                "chat",
                "chat room",
                "A live chat room for the show.",
                "irc irc.example.test [space]",
                "podcast:chat",
                extras.chat,
            ),
            _optional(
                scope,
                "value",
                "payment address",
                "A Lightning node that listeners can send to.",
                "node-address [name]",
                "podcast:value",
                extras.value_node,
            ),
        ]
    rows += [
        _optional(
            episode,
            "alternateEnclosure",
            "another format",
            "Another file of this episode, such as video.",
            "https://example.test/ep.ogg [audio/ogg]",
            "podcast:alternateEnclosure",
            extras.alternate_enclosure,
        ),
        _optional(
            episode,
            "remoteItem",
            "related episode",
            "An episode of another feed this one belongs with.",
            "feed-guid [item-guid]",
            "podcast:remoteItem",
            extras.remote_item,
        ),
    ]
    return tuple(rows)


_CORE_FIELDS: tuple[FieldSpec, ...] = (
    _show(
        "channel.title",
        "show title",
        "The show's name.",
        _TEXT,
        Tag("title"),
        needs=Need("blocker", "RSS", "The feed needs a show title."),
    ),
    _show(
        "channel.description",
        "show description",
        "What the show is about, plain text.",
        _TEXT,
        Tag("description"),
        needs=Need("blocker", "RSS", "The feed needs a show description."),
        checks=(_long_description,),
    ),
    _show(
        "channel.link",
        "website",
        "The show's website address.",
        TypeAdapter(Https),
        Tag("link"),
        needs=Need("blocker", "RSS", "The feed needs a website address."),
    ),
    _show(
        "channel.language",
        "language",
        "Language code such as en or pt-BR.",
        TypeAdapter(Language),
        Tag("language"),
        needs=Need("warn", "Apple", "Apple needs the show's language."),
        derive=_language,
    ),
    _show(
        "channel.author",
        "author",
        "Who makes the show, as listeners see it.",
        _TEXT,
        Tag("itunes:author"),
        needs=Need("info", "Apple", "No author. Apple shows it under the title."),
    ),
    _show(
        "channel.category",
        "category",
        "An Apple Podcasts category such as Society & Culture.",
        _TEXT,
        Tag("itunes:category", attr="text"),
        needs=Need("warn", "Apple", "Apple needs a category."),
    ),
    _show(
        "channel.explicit",
        "explicit",
        "Whether the show has explicit content.",
        _BOOL,
        Tag("itunes:explicit"),
        needs=Need("warn", "Apple", "Apple needs to know if the show is explicit."),
    ),
    _show(
        "channel.image",
        "artwork",
        "Square show artwork, 1400 to 3000 pixels: an https address, or a .jpg or .png file here that the export copies beside the audio.",
        TypeAdapter(ArtRef),
        Tag("itunes:image", attr="href"),
        needs=Need("warn", "Apple", "Apple needs show artwork of at least 1400 by 1400 pixels."),
        pin_resolve=_channel_image,
    ),
    _show(
        "channel.owner.name",
        "owner name",
        "Who owns the show. Public in the feed.",
        _TEXT,
        Tag("itunes:owner/itunes:name"),
        listed="known",
    ),
    _show(
        "channel.owner.email",
        "owner email",
        "Where Spotify and YouTube send the ownership check. Public in the feed.",
        TypeAdapter(Email),
        Tag("itunes:owner/itunes:email"),
        needs=Need(
            "info",
            "Spotify",
            "No owner email. Spotify and YouTube verify ownership by emailing it.",
        ),
    ),
    _show(
        "channel.copyright",
        "copyright",
        "A copyright line without the word Copyright.",
        _TEXT,
        Tag("copyright"),
        listed="known",
    ),
    _show(
        "channel.mediaUrl",
        "hosting address",
        "Where files will live, with {file} where the file name goes.",
        TypeAdapter(Template),
        derive=_media_url,
        host_only=True,
    ),
    _show(
        "channel.feedUrl",
        "feed address",
        "Where the feed file will live. Made from the hosting address.",
        _TEXT,
        Tag("atom:link", attr="href", fixed=(("rel", "self"), ("type", "application/rss+xml"))),
        derive=_feed_url,
        edit="none",
    ),
    _show(
        "channel.podcastGuid",
        "podcast guid",
        "The show's Podcasting 2.0 id. Made from the feed address.",
        _TEXT,
        Tag("podcast:guid"),
        derive=_podcast_guid,
        edit="none",
    ),
    _show(
        "channel.season",
        "season",
        "The season every episode of the show is in until an episode sets its own.",
        _NUMBER,
        listed="known",
    ),
    _show(
        "channel.roster",
        "hosts",
        "The people who host the show, matched to speakers by name.",
        TypeAdapter(list[str]),
        derive=_roster_names,
        edit=AtSource("roster", "Set a person with channel.person[Name].role, group, img or href."),
        listed="known",
    ),
    FieldSpec(
        key="item.title",
        scope="episode",
        label="title",
        help="The episode title. Defaults to the project name.",
        value=_TEXT,
        edit="pin",
        tags=(Tag("title"),),
        derive=_title,
        checks=(_long_title,),
        drift_hint="The project name changed since you set this title.",
    ),
    FieldSpec(
        key="item.intro",
        scope="episode",
        label="intro",
        help="A line or two about this episode. Leads the show notes.",
        value=_TEXT,
        edit="pin",
        missing="Say what this episode is about.",
        needs=Need("warn", "Apple", "Apple shows the intro as the episode description."),
    ),
    FieldSpec(
        key="item.pubDate",
        scope="episode",
        label="publish date",
        help="When the episode goes out, as an ISO 8601 time. Defaults to the first export.",
        value=_MOMENT,
        edit="pin",
        tags=(Tag("pubDate"),),
        derive=_pub_date,
        drift_hint="The first export time changed since you set this date.",
    ),
    FieldSpec(
        key="item.guid",
        scope="episode",
        label="guid",
        help="The episode's permanent id. Made once and never edited.",
        value=_TEXT,
        edit="mint",
        tags=(Tag("guid", fixed=(("isPermaLink", "false"),)),),
        derive=_guid,
        needs=Need("info", "RSS", "Created when you write the feed file."),
    ),
    FieldSpec(
        key="item.enclosure.url",
        scope="episode",
        label="hosting address",
        help="The full https address of the audio file. Defaults to the show's hosting address.",
        value=TypeAdapter(Https),
        edit="pin",
        tags=(Tag("enclosure", attr="url"),),
        derive=_enclosure_url,
        needs=Need("blocker", "RSS", "The feed needs an address for the audio file."),
        drift_hint="The hosting address or the exported file changed since you set this address.",
    ),
    FieldSpec(
        key="item.enclosure.length",
        scope="episode",
        label="file size",
        help="Bytes of the exported audio file.",
        value=TypeAdapter(int),
        edit="none",
        tags=(Tag("enclosure", attr="length"),),
        derive=_enclosure_length,
        needs=Need("blocker", "RSS"),
    ),
    FieldSpec(
        key="item.enclosure.type",
        scope="episode",
        label="file type",
        help="The audio file's media type.",
        value=_TEXT,
        edit="none",
        tags=(Tag("enclosure", attr="type"),),
        derive=_enclosure_type,
    ),
    FieldSpec(
        key="item.duration",
        scope="episode",
        label="duration",
        help="Seconds, read from the exported WAV.",
        value=TypeAdapter(int),
        edit="none",
        tags=(Tag("itunes:duration"),),
        derive=_duration,
    ),
    FieldSpec(
        key="item.explicit",
        scope="episode",
        label="explicit",
        help="Whether this episode is explicit. Defaults to the show.",
        value=_BOOL,
        edit="pin",
        tags=(Tag("itunes:explicit"),),
        inherit="channel.explicit",
        listed="known",
    ),
    FieldSpec(
        key="item.season",
        scope="episode",
        label="season",
        help="The season number.",
        value=_NUMBER,
        edit="pin",
        tags=(Tag("itunes:season"),),
        inherit="channel.season",
        listed="known",
    ),
    FieldSpec(
        key="item.episode",
        scope="episode",
        label="episode number",
        help="The episode number.",
        value=_NUMBER,
        edit="pin",
        tags=(Tag("itunes:episode"),),
        derive=_episode_number,
        listed="known",
        needs=Need("info", "Apple", "No episode number. Apple groups numbered episodes."),
    ),
    FieldSpec(
        key="item.episodeType",
        scope="episode",
        label="episode type",
        help="full, trailer or bonus.",
        value=_EPISODE_TYPE,
        edit="pin",
        tags=(Tag("itunes:episodeType"),),
        derive=_episode_type,
        listed="known",
    ),
    FieldSpec(
        key="item.image",
        scope="episode",
        label="artwork",
        help="Episode artwork at an https address. Defaults to the show's.",
        value=TypeAdapter(Https),
        edit="pin",
        tags=(Tag("itunes:image", attr="href"),),
        derive=_art,
        section="art",
        pin_shape=lambda res, src: _art_for(res, src),
    ),
    FieldSpec(
        key="item.audio",
        scope="episode",
        label="audio file",
        help="The exported audio file, by name and size.",
        value=_TEXT,
        edit="none",
        derive=_audio,
        section="audio",
    ),
    FieldSpec(
        key="item.chapters",
        scope="episode",
        label="chapters",
        help="Chapter markers, shown in the notes and linked as a chapters file.",
        value=_TEXT,
        edit=AtSource("chapters", "Edit chapters in the Chapters list."),
        tags=(Tag("podcast:chapters"),),
        derive=_chapters,
        section="chapters",
        checks=(_long_chapter_titles,),
    ),
    FieldSpec(
        key="item.transcript",
        scope="episode",
        label="transcripts",
        help="Every SRT and VTT transcript the export wrote.",
        value=_TEXT,
        edit=AtSource("transcript", "Choose transcript formats in the Transcript section."),
        tags=(Tag("podcast:transcript"),),
        derive=_transcripts,
        section="transcripts",
    ),
    FieldSpec(
        key="item.soundbite",
        scope="episode",
        label="soundbites",
        help="Approved clips, offered to apps as highlights.",
        value=_TEXT,
        edit=AtSource("clips", "Approve clips in the Clips row."),
        tags=(Tag("podcast:soundbite"),),
        derive=_soundbites,
        section="soundbites",
        checks=(_soundbite_lengths,),
    ),
    FieldSpec(
        key="item.person",
        scope="episode",
        label="people",
        help="Speakers matched to the show's host list. Pin item.person[Name].role, group, img, href or exclude to change one.",
        value=_TEXT,
        edit=AtSource("speakers", "Name speakers in the Edit stage."),
        tags=(Tag("podcast:person"),),
        derive=_credits,
        section="credits",
        checks=(_unmatched_guests,),
    ),
    FieldSpec(
        key="item.notes",
        scope="episode",
        label="notes",
        help="Show notes. Left alone they are the intro, chapters, credits and transcript link. Setting them pins the whole text.",
        value=TypeAdapter(str),
        edit="pin",
        tags=(Tag("description", cdata=True), Tag("content:encoded", cdata=True)),
        derive=_notes,
        listed="pinned",
        drift_hint="The intro, chapters or credits changed since you edited the notes.",
    ),
)

FIELDS: tuple[FieldSpec, ...] = (*_CORE_FIELDS, *_optional_rows())

FIELD_BY_KEY: Mapping[str, FieldSpec] = {spec.key: spec for spec in FIELDS}

TAXONOMY_ROLES = (
    "host",
    "co-host",
    "guest",
    "guest host",
    "voice actor",
    "narrator",
    "announcer",
    "reporter",
    "author",
    "editorial director",
    "co-writer",
    "writing staff",
    "songwriter",
    "guest writer",
    "story editor",
    "managing editor",
    "script editor",
    "script coordinator",
    "researcher",
    "editor",
    "fact checker",
    "translator",
    "transcriber",
    "logger",
    "studio coordinator",
    "technical director",
    "technical manager",
    "audio engineer",
    "remote recording engineer",
    "post production engineer",
    "audio editor",
    "sound designer",
    "foley artist",
    "composer",
    "theme music",
    "music production",
    "music contributor",
    "production coordinator",
    "booking coordinator",
    "production assistant",
    "content manager",
    "marketing manager",
    "sales representative",
    "sales manager",
    "graphic designer",
    "cover art designer",
    "social media manager",
    "consultant",
    "intern",
    "camera operator",
    "lighting designer",
    "camera grip",
    "assistant camera",
    "producer",
    "executive producer",
    "senior producer",
    "supervising producer",
    "associate producer",
    "director",
    "assistant director",
    "creative director",
    "art director",
    "community manager",
    "moderator",
)


def _taxonomy_role(value: str) -> str:
    role = " ".join(value.split()).casefold()
    if role not in TAXONOMY_ROLES:
        raise ValueError(f"must be a Podcast Taxonomy role: {', '.join(TAXONOMY_ROLES)}")
    return role


_PERSON_TEXT = TypeAdapter(
    Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=NAME_MAX)]
)
_PERSON_VALUES: Mapping[str, TypeAdapter[Any]] = {
    "role": TypeAdapter(Annotated[str, AfterValidator(_taxonomy_role)]),
    "group": _PERSON_TEXT,
    "img": TypeAdapter(Https),
    "href": TypeAdapter(Https),
    "exclude": _BOOL,
}
SHOW_PERSON_KEY = re.compile(
    rf"^channel\.person\[(?P<name>[^\]]{{1,{NAME_MAX}}})\](?:\.(?P<attr>role|group|img|href))?$"
)
_SHOW_PERSON_PIN = FieldSpec(
    key="channel.person[*]",
    scope="show",
    label="host",
    help="One attribute of one person on the show's host list.",
    value=_TEXT,
    edit="pin",
)
_PERSON_PIN = FieldSpec(
    key="item.person[*]",
    scope="episode",
    label="person",
    help="One attribute of one person.",
    value=_TEXT,
    edit="pin",
)


def guest_pinnable(key: str, scope: Literal["show", "episode"]) -> bool:
    """Whether a share link may pin ``key``: a row of ``scope`` that a pin edits and the host has not kept."""
    spec = lookup(key)
    return spec is not None and spec.scope == scope and spec.edit == "pin" and not spec.host_only


def lookup(key: str) -> FieldSpec | None:
    """The row for ``key``, including a per-person attribute such as ``item.person[Ana].href``."""
    if (spec := FIELD_BY_KEY.get(key)) is not None:
        return spec
    if (match := PERSON_KEY.match(key)) is not None:
        return replace(_PERSON_PIN, key=key, value=_PERSON_VALUES[match["attr"]])
    if (match := SHOW_PERSON_KEY.match(key)) is not None:
        attr = match["attr"]
        return replace(_SHOW_PERSON_PIN, key=key, value=_PERSON_VALUES[attr or "role"])
    return None
