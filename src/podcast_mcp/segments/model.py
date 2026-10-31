"""The segment file format: ``segment.json`` and the media it names."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from podcast_mcp.models.episode import ClipJoinMode, TrackRole
from podcast_mcp.util.coded_error import CodedValueError

SegmentKind = Literal["intro", "outro", "sponsor", "sting", "other"]

SEGMENT_KINDS: tuple[SegmentKind, ...] = get_args(SegmentKind)
SEGMENT_JSON = "segment.json"
MANIFEST_NAME = "MANIFEST.sha256"
MAX_SEGMENT_JSON_BYTES = 1024 * 1024
_SLUG_MAX = 48
_VALID_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def segment_id_for(name: str) -> str:
    """A file-safe id for ``name``: its ASCII slug plus a short hash of the exact name."""
    stripped = name.strip()
    folded = unicodedata.normalize("NFKD", stripped).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")[:_SLUG_MAX].strip("-")
    if not slug:
        raise CodedValueError(
            "A segment needs a name with letters or digits in it.", code="segment_name_invalid"
        )
    return f"{slug}-{hashlib.sha256(stripped.encode('utf-8')).hexdigest()[:8]}"


def segment_kind(value: str) -> SegmentKind:
    for kind in SEGMENT_KINDS:
        if kind == value:
            return kind
    raise CodedValueError(
        f"{value!r} is not a segment kind. Use one of {', '.join(SEGMENT_KINDS)}.",
        code="segment_kind_invalid",
    )


def is_segment_id(value: str) -> bool:
    return len(value) <= _SLUG_MAX + 9 and bool(_VALID_ID.fullmatch(value))


def is_safe_media_name(name: str) -> bool:
    """A plain file name: no directories, no leading dot, and not the manifest files."""
    return (
        bool(_SAFE_NAME.fullmatch(name))
        and name.casefold() not in (SEGMENT_JSON, MANIFEST_NAME.casefold())
        and ".." not in name
    )


def read_capped(path: Path, limit: int, *, what: str, code: str) -> bytes:
    """Read a small metadata file, refusing one over ``limit`` bytes or that cannot be read."""
    try:
        with path.open("rb") as handle:
            raw = handle.read(limit + 1)
    except OSError as exc:
        raise CodedValueError(f"{what} cannot be read: {exc.strerror or exc}.", code=code) from exc
    if len(raw) > limit:
        raise CodedValueError(f"{what} is larger than {limit} bytes.", code=code)
    return raw


class MediaEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sha256: str = Field(pattern=_SHA256.pattern)
    bytes: int = Field(ge=0)


class SegmentClip(BaseModel):
    """One piece of audio, placed relative to the start of the segment."""

    model_config = ConfigDict(extra="forbid")

    audio: str
    offset_sec: float = Field(ge=0, allow_inf_nan=False)
    duration_sec: float = Field(gt=0, allow_inf_nan=False)
    fade_in_ms: int = Field(default=0, ge=0)
    fade_out_ms: int = Field(default=0, ge=0)
    join_in_mode: ClipJoinMode = ClipJoinMode.FADE
    lane: int = Field(default=0, ge=0)


class SegmentWord(BaseModel):
    """A transcript word, in seconds from the start of the segment."""

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _ordered(self) -> SegmentWord:
        if self.end < self.start:
            raise ValueError("a word cannot end before it starts")
        return self


class SegmentFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    id: str
    name: str = Field(min_length=1)
    kind: SegmentKind
    version: Annotated[int, Field(ge=1)] = 1
    role: TrackRole
    fader_db: float = Field(default=0.0, allow_inf_nan=False)
    duck_under_dialogue: bool = False
    chapter_title: str | None = None
    clips: list[SegmentClip] = Field(min_length=1)
    transcript_words: list[SegmentWord] | None = None
    media: dict[str, MediaEntry]

    @model_validator(mode="after")
    def _consistent(self) -> SegmentFile:
        if not is_segment_id(self.id):
            raise ValueError(f"{self.id!r} is not a segment id")
        for name in self.media:
            if not is_safe_media_name(name):
                raise ValueError(f"{name!r} is not a plain media file name")
        if len({name.casefold() for name in self.media}) != len(self.media):
            raise ValueError("media file names must differ by more than letter case")
        for clip in self.clips:
            if clip.audio not in self.media:
                raise ValueError(f"clip audio {clip.audio!r} is not in media")
        return self

    @property
    def duration_sec(self) -> float:
        return max(clip.offset_sec + clip.duration_sec for clip in self.clips)

    @property
    def content_sha256(self) -> str:
        """Identifies the content: the media hashes and the layout, not the name or version."""
        layout = self.model_dump(
            mode="json",
            exclude={"id", "name", "version", "media", "schema_version"},
        )
        payload = {
            "media": sorted(entry.sha256 for entry in self.media.values()),
            "layout": layout,
        }
        text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_segment(raw: bytes | str) -> SegmentFile:
    """Read ``segment.json``. Raises ``segment_schema_unsupported`` or ``segment_invalid``."""
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise CodedValueError("segment.json is not valid JSON.", code="segment_invalid") from exc
    if not isinstance(data, dict):
        raise CodedValueError("segment.json must hold one object.", code="segment_invalid")
    if data.get("schema_version") != 1:
        raise CodedValueError(
            f"This segment uses schema version {data.get('schema_version')!r}, "
            "which this app does not read.",
            code="segment_schema_unsupported",
        )
    try:
        return SegmentFile.model_validate(data)
    except ValidationError as exc:
        raise CodedValueError(
            f"segment.json is not a segment file: {exc.errors()[0]['msg']}.",
            code="segment_invalid",
        ) from exc


def segment_json(segment: SegmentFile) -> str:
    return json.dumps(segment.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n"
