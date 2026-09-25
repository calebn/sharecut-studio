"""Typed transport commands - all writers (agent/viewer/cli) use these."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Literal, get_args
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

ClientRole = Literal["agent", "viewer", "cli"]


def retry_command_id(
    *,
    client_id: str,
    client_seq: int,
    role: str,
    type: str,
    payload: dict[str, Any],
    causation_id: str | None = None,
) -> str:
    """Stable identity for explicit commands whose transport omitted an ID."""
    encoded = json.dumps(
        [client_id, client_seq, role, type, payload, causation_id],
        sort_keys=True,
        separators=(",", ":"),
    )
    return "derived-" + hashlib.sha256(encoded.encode()).hexdigest()


CommandType = Literal[
    "SetPlayhead",
    "SetPlaying",
    "SetMode",
    "SetRegion",
    "ClearRegion",
    "SetSelection",
    "SetMuteSolo",
    "PlayOsAudio",
    "AuditionInViewer",
    "Ack",
    "PresenceHeartbeat",
    "FollowUser",
]

TRANSPORT_FIELDS = frozenset(
    {
        "playhead_sec",
        "is_playing",
        "audition_mode",
        "region",
        "source",
        "track_id",
        "query",
        "match_index",
        "selection",
        "viewer_mute",
        "solo_tracks",
        "tier",
        "dry_run",
        "wav",
        "compare_segments",
    }
)


@dataclass
class SyncCommand:
    type: CommandType
    payload: dict[str, Any]
    client_id: str
    role: ClientRole
    client_seq: int | None
    command_id: str = field(default_factory=lambda: uuid4().hex)
    causation_id: str | None = None

    def to_row(self) -> dict[str, Any]:
        return {
            "command_id": self.command_id,
            "client_id": self.client_id,
            "client_seq": self.client_seq,
            "role": self.role,
            "type": self.type,
            "payload": self.payload,
            "causation_id": self.causation_id,
        }


def audition_mode_from_source(source: str | None) -> str:
    if not source:
        return "mix"
    if source.startswith("track:") or "track:" in source:
        return "raw"
    if (
        source.startswith("processed:")
        or "processed:" in source
        or source.startswith("follow-transcript:processed")
    ):
        return "fx"
    return "mix"


PRESENCE_COLOR_COUNT = 8
RESERVED_DISPLAY_NAMES = frozenset({"host", "agent", "daw"})
_FNV_OFFSET = 2166136261
_FNV_PRIME = 16777619
_WHITESPACE_RE = re.compile(r"\s+")
_MAX_DISPLAY_NAME = 40

PresenceSelectionKind = Literal[
    "clip",
    "track",
    "comment",
    "social",
    "chapter",
    "marker",
    "pending",
    "applied",
    "transcriptWord",
    "transcriptRange",
    "envelopePoint",
]

_ANCHOR_RE = r"^[a-z0-9][a-z0-9_.:-]{0,95}$"
PresenceTab = Literal["transcript", "history", "impact", "tighten", "pipeline", "comments"]
PRESENCE_TABS = set(get_args(PresenceTab))
PresenceMobileMode = Literal["listen", "timeline", "text", "more"]
PresenceAudition = Literal["mix", "fx", "raw"]


class PresenceCursor(BaseModel):
    model_config = ConfigDict(extra="ignore")
    t_sec: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    track_id: str | None = Field(default=None, max_length=64)
    lane_pos: float | None = Field(default=None, ge=0, le=512, allow_inf_nan=False)
    anchor: str | None = Field(default=None, pattern=_ANCHOR_RE)
    x: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def _shape(self) -> PresenceCursor:
        if self.anchor is None and self.t_sec is None:
            raise ValueError("cursor needs t_sec or anchor")
        return self


# Shortest viewport span a client may publish (mirrored in the GUI's
# presence/followSync.ts).
MIN_VIEWPORT_SPAN_SEC = 0.001


class PresenceViewport(BaseModel):
    """The time window a follower should show: a padded phone timeline
    scrolled before 0 publishes ``[0, span]`` (the leader's span, so followers
    keep its zoom), which can be wider than the range actually on screen."""

    model_config = ConfigDict(extra="ignore")
    start_sec: float = Field(ge=0, allow_inf_nan=False)
    end_sec: float = Field(ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _span(self) -> PresenceViewport:
        if self.end_sec - self.start_sec < MIN_VIEWPORT_SPAN_SEC:
            raise ValueError(f"viewport span must be >= {MIN_VIEWPORT_SPAN_SEC}s")
        return self


class PresenceTransport(BaseModel):
    model_config = ConfigDict(extra="ignore")
    playing: bool
    playhead_sec: float = Field(ge=0, allow_inf_nan=False)
    rate: float = Field(default=1.0, ge=0.5, le=2.0, allow_inf_nan=False)
    stamped_ns: int | None = None


class PresenceSelection(BaseModel):
    model_config = ConfigDict(extra="ignore")
    kind: PresenceSelectionKind
    id: str | None = Field(default=None, max_length=64)
    track_id: str | None = Field(default=None, max_length=64)
    time: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    word_index: int | None = Field(default=None, ge=0)
    word_end: int | None = Field(default=None, ge=0)


class PresenceUi(BaseModel):
    model_config = ConfigDict(extra="ignore")
    tab: PresenceTab | None = None
    mobile_mode: PresenceMobileMode | None = None
    transcript_anchor: str | None = Field(default=None, pattern=_ANCHOR_RE)
    audition: PresenceAudition | None = None
    viewer_mute: list[str] = Field(default_factory=list, max_length=64)
    solo: list[str] = Field(default_factory=list, max_length=64)

    @field_validator("viewer_mute", "solo")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        return [s[:64] for s in v if isinstance(s, str) and s]


class PresenceMeta(BaseModel):
    model_config = ConfigDict(extra="ignore")
    display_name: str | None = Field(default=None, max_length=_MAX_DISPLAY_NAME)
    color_index: int | None = Field(default=None, ge=0, le=7)
    cursor: PresenceCursor | None = None
    selection: PresenceSelection | None = None
    viewport: PresenceViewport | None = None
    transport: PresenceTransport | None = None
    following: str | None = Field(default=None, max_length=64)
    ui: PresenceUi | None = None


def presence_color_index(client_id: str) -> int:
    """Deterministic FNV-1a 32-bit hash of ``client_id`` into 0..7."""
    h = _FNV_OFFSET
    for byte in client_id.encode("utf-8"):
        h ^= byte
        h = (h * _FNV_PRIME) & 0xFFFFFFFF
    return h % PRESENCE_COLOR_COUNT


def sanitize_display_name(raw: Any, *, guest: bool = False) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raw = str(raw)
    chars: list[str] = []
    for ch in raw:
        if unicodedata.category(ch) in {"Cc", "Cf"}:
            continue
        chars.append(ch)
    text = _WHITESPACE_RE.sub(" ", "".join(chars)).strip()
    if not text:
        return None
    text = text[:_MAX_DISPLAY_NAME]
    if guest and text.casefold() in RESERVED_DISPLAY_NAMES:
        suffix = " (guest)"
        text = (text[: _MAX_DISPLAY_NAME - len(suffix)] + suffix)[:_MAX_DISPLAY_NAME]
    return text


def normalize_presence_meta(raw: Any, *, guest: bool = False) -> dict[str, Any] | None:
    """Validate presence meta. Returns None on invalid input (never raise)."""
    if raw is None or not isinstance(raw, dict):
        return None
    payload = dict(raw)
    if "display_name" in payload:
        payload["display_name"] = sanitize_display_name(payload.get("display_name"), guest=guest)
    ui = payload.get("ui")
    if isinstance(ui, dict) and "tab" in ui:
        tab = ui.get("tab")
        if tab not in PRESENCE_TABS:
            ui = dict(ui)
            ui.pop("tab", None)
            payload["ui"] = ui
    try:
        model = PresenceMeta.model_validate(payload)
    except ValidationError:
        return None
    return model.model_dump(exclude_unset=True)


def track_id_from_source(source: str | None) -> str | None:
    if not source:
        return None
    if source.startswith("processed:"):
        return source.split(":", 1)[1] or None
    if source.startswith("track:"):
        return source.split(":", 1)[1] or None
    if "processed:" in source:
        return source.rsplit(":", 1)[-1] or None
    return None
