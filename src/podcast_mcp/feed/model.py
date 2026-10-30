"""Wire and domain types for the podcast listing.

``FeedView`` serializes to the shape ``gui/web/src/stages/deliver/feedView.ts`` declares:
``FeedView.wire()`` is the one place that spells it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any, Generic, Literal, Protocol, TypeVar

from pydantic import BaseModel, ConfigDict, Field, model_validator

from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.feed import FieldValue, Pin, PinAuthor

FieldKey = str
ShowId = str

T = TypeVar("T")


class WireModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class SetEdit(WireModel):
    op: Literal["set"] = "set"
    key: FieldKey
    value: FieldValue


class UnsetEdit(WireModel):
    op: Literal["unset"] = "unset"
    key: FieldKey


FeedEdit = Annotated[SetEdit | UnsetEdit, Field(discriminator="op")]

FeedCommand = Literal["export_episode", "create_show", "link_show", "choose_art", "write_feed"]


class EditFix(WireModel):
    kind: Literal["edit"] = "edit"
    edit: FeedEdit


class InputFix(WireModel):
    """Only a person can supply the value for ``key``; a surface asks, then sends a set."""

    kind: Literal["input"] = "input"
    key: FieldKey


class CommandFix(WireModel):
    kind: Literal["command"] = "command"
    command: FeedCommand
    args: dict[str, str] | None = None


Fix = Annotated[EditFix | InputFix | CommandFix, Field(discriminator="kind")]


class Derived(WireModel):
    kind: Literal["derived"] = "derived"
    rule: str


class Inherited(WireModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    kind: Literal["inherited"] = "inherited"
    from_: FieldKey = Field(alias="from")


def inherited(from_key: FieldKey) -> Inherited:
    return Inherited.model_validate({"from": from_key})


class Measured(WireModel):
    kind: Literal["measured"] = "measured"
    file: str


class Minted(WireModel):
    kind: Literal["minted"] = "minted"
    at: str


class Pinned(WireModel):
    kind: Literal["pinned"] = "pinned"
    by: PinAuthor
    drifted: bool = False


class Pending(WireModel):
    kind: Literal["pending"] = "pending"
    why: str
    fix: Fix | None = None


Resolved = Derived | Inherited | Measured | Minted | Pinned
Provenance = Annotated[Resolved | Pending, Field(discriminator="kind")]


class Fact(WireModel, Generic[T]):
    value: T | None
    source: Provenance

    @model_validator(mode="after")
    def _value_iff_known(self) -> Fact[T]:
        if (self.value is None) != isinstance(self.source, Pending):
            raise ValueError("a fact has a value exactly when it is not pending")
        return self


class Art(WireModel):
    src: str
    alt: str


class FeedChapter(WireModel):
    at: float
    title: str


class Credit(WireModel):
    name: str
    role: str
    group: str | None = None
    img: str | None = None
    href: str | None = None


class Transcript(WireModel):
    format: Literal["SRT", "VTT"]
    language: str


class Soundbite(WireModel):
    title: str
    start: float
    end: float


class AudioFile(WireModel):
    mime: str
    bytes: int


class Sections(WireModel):
    art: Fact[Art]
    audio: Fact[AudioFile]
    chapters: Fact[list[FeedChapter]]
    credits: Fact[list[Credit]]
    transcripts: Fact[list[Transcript]]
    soundbites: Fact[list[Soundbite]]


class ShowSuggestion(WireModel):
    language: str
    hosts: list[Credit]


class NoShow(WireModel):
    kind: Literal["none"] = "none"
    suggest: ShowSuggestion


class ShowChoice(WireModel):
    id: ShowId
    title: str


class ChooseShow(WireModel):
    kind: Literal["choose"] = "choose"
    shows: list[ShowChoice]


class ReadyShow(WireModel):
    kind: Literal["ready"] = "ready"
    id: ShowId


ShowState = Annotated[NoShow | ChooseShow | ReadyShow, Field(discriminator="kind")]

Severity = Literal["blocker", "warn", "info"]
FileState = Literal["none", "current", "stale"]


class Finding(WireModel):
    key: FieldKey | None
    severity: Severity
    platform: str | None
    message: str
    fix: Fix | None


ScalarFact = Fact[FieldValue]


class FeedView(WireModel):
    show: ShowState
    channel: dict[FieldKey, ScalarFact]
    item: dict[FieldKey, ScalarFact]
    sections: Sections
    notes_html: str = Field(alias="notesHtml")
    drift_detail: dict[FieldKey, str] | None = Field(default=None, alias="driftDetail")
    findings: list[Finding]
    file: FileState

    def wire(self) -> dict[str, Any]:
        """The JSON object the web app and every adapter exchange (camelCase, absent when unset)."""
        data = self.model_dump(mode="json", by_alias=True)
        if not data["driftDetail"]:
            del data["driftDetail"]
        return _drop_unset_wire_keys(data)


_OPTIONAL_WIRE_KEYS = frozenset({"args", "group", "img", "href"})


def _drop_unset_wire_keys(node: Any) -> Any:
    if isinstance(node, dict):
        return {
            key: _drop_unset_wire_keys(value)
            for key, value in node.items()
            if not (key in _OPTIONAL_WIRE_KEYS and value is None)
        }
    if isinstance(node, list):
        return [_drop_unset_wire_keys(item) for item in node]
    return node


@dataclass(frozen=True)
class Person:
    name: str
    role: str = "host"
    group: str = "cast"
    img: str | None = None
    href: str | None = None


def usable_ledger(ledger: Mapping[str, int]) -> dict[str, int]:
    """The ledger entries that are positive and not already held by an earlier entry."""
    kept: dict[str, int] = {}
    held: set[int] = set()
    for guid, number in ledger.items():
        if number > 0 and number not in held:
            kept[guid] = number
            held.add(number)
    return kept


@dataclass(frozen=True)
class ShowSummary:
    id: ShowId
    title: str


class ShowProfile(Protocol):
    """What a show contributes to a listing: channel pins, a roster and the hosting template."""

    @property
    def id(self) -> ShowId: ...

    @property
    def pins(self) -> Mapping[str, Pin]: ...

    @property
    def roster(self) -> Sequence[Person]: ...

    @property
    def media_url(self) -> str | None: ...

    @property
    def ledger(self) -> Mapping[str, int]:
        """Episode numbers by guid, assigned when each episode's feed file is first written."""
        ...


class ShowSource(Protocol):
    """Where shows come from: the show store on a machine, ``NoShows`` when there is none."""

    def shows(self) -> Sequence[ShowSummary]: ...

    def profile(self, show_id: ShowId) -> ShowProfile | None: ...


class NoShows:
    def shows(self) -> Sequence[ShowSummary]:
        return ()

    def profile(self, show_id: ShowId) -> ShowProfile | None:
        return None


@dataclass(frozen=True)
class ExportFile:
    name: str
    bytes: int
    seconds: float | None = None


@dataclass(frozen=True)
class ExportFiles:
    """What the export directory holds for this episode, gathered once per read."""

    audio: ExportFile | None = None
    wav: ExportFile | None = None
    transcripts: tuple[ExportFile, ...] = ()
    feed_xml: str | None = None


@dataclass(frozen=True)
class FeedInputs:
    project: EpisodeProject
    show: ShowProfile | None = None
    shows: Sequence[ShowSummary] = ()
    files: ExportFiles = field(default_factory=ExportFiles)
    # The show's artwork file on this machine, when the show names one instead of an address.
    show_art: ExportFile | None = None
    # Show files that could not be used, one sentence each naming the file.
    show_problems: tuple[str, ...] = ()
