"""Record-plane commands, payload validation, and role allowlists."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from podcast_mcp.edits.comments import COMMENT_BODY_MAX
from podcast_mcp.edits.share_capabilities import CAP_COMMENT, CAP_JOIN
from podcast_mcp.services.record.live_comments import (
    RecordLiveCommentError,
    parse_comment_id,
)
from podcast_mcp.services.record.state import RecordRole
from podcast_mcp.services.session_sync.commands import sanitize_display_name

RecordCommandType = Literal[
    "Join",
    "Leave",
    "Consent",
    "SetMuted",
    "HeadphonesAck",
    "Heartbeat",
    "Start",
    "Pause",
    "Resume",
    "Stop",
    "RemoveParticipant",
    "UpdateName",
    "Comment",
]

COMMAND_TYPES: frozenset[str] = frozenset(
    {
        "Join",
        "Leave",
        "Consent",
        "SetMuted",
        "HeadphonesAck",
        "Heartbeat",
        "Start",
        "Pause",
        "Resume",
        "Stop",
        "RemoveParticipant",
        "UpdateName",
        "Comment",
    }
)

HOST_ONLY: frozenset[str] = frozenset({"Start", "Pause", "Resume", "Stop", "RemoveParticipant"})
REQUIRES_JOIN_CAP: frozenset[str] = frozenset({"Consent", "SetMuted"})
REQUIRES_COMMENT_CAP: frozenset[str] = frozenset({"Comment"})


class RecordAuthzError(PermissionError):
    """Role or capability does not allow this command."""


class JoinPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    display_name: str
    participant_id: str | None = None
    lease: str | None = None

    @field_validator("display_name", mode="before")
    @classmethod
    def _name(cls, value: Any) -> str:
        cleaned = sanitize_display_name(value, guest=False)
        if not cleaned:
            raise ValueError("display_name is required")
        return cleaned


class ConsentPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    accepted: bool


class SetMutedPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    muted: bool


class HeadphonesAckPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ok: bool


class RemoveParticipantPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    participant_id: str = Field(min_length=1)


class UpdateNamePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    display_name: str

    @field_validator("display_name", mode="before")
    @classmethod
    def _name(cls, value: Any) -> str:
        cleaned = sanitize_display_name(value, guest=False)
        if not cleaned:
            raise ValueError("display_name is required")
        return cleaned


class CommentPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=64)
    take_index: int = 0
    recording_ms: int = 0
    pressed_wall_ms: int | None = None
    body: str = Field(min_length=1, max_length=COMMENT_BODY_MAX)

    @field_validator("id")
    @classmethod
    def _id(cls, value: str) -> str:
        try:
            return parse_comment_id(value)
        except RecordLiveCommentError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("body", mode="before")
    @classmethod
    def _body(cls, value: Any) -> str:
        cleaned = str(value or "").strip()
        if not cleaned:
            raise ValueError("body is required")
        if len(cleaned) > COMMENT_BODY_MAX:
            raise ValueError(f"body exceeds {COMMENT_BODY_MAX} characters")
        return cleaned

    @field_validator("pressed_wall_ms", "take_index", "recording_ms", mode="before")
    @classmethod
    def _nonneg(cls, value: Any) -> Any:
        if value is None:
            return value
        parsed = int(value)
        if parsed < 0:
            raise ValueError("must be >= 0")
        return parsed


_PAYLOAD_MODELS: dict[str, type[BaseModel]] = {
    "Join": JoinPayload,
    "Consent": ConsentPayload,
    "SetMuted": SetMutedPayload,
    "HeadphonesAck": HeadphonesAckPayload,
    "RemoveParticipant": RemoveParticipantPayload,
    "UpdateName": UpdateNamePayload,
    "Comment": CommentPayload,
}


def validate_record_payload(command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if command_type not in COMMAND_TYPES:
        raise ValueError(f"unknown record command type: {command_type}")
    model = _PAYLOAD_MODELS.get(command_type)
    if model is None:
        return {}
    return model.model_validate(payload or {}).model_dump()


@dataclass
class RecordCommand:
    type: RecordCommandType
    payload: dict[str, Any]
    client_id: str
    role: RecordRole
    participant_id: str | None
    client_seq: int
    command_id: str = field(default_factory=lambda: uuid4().hex)

    @classmethod
    def parse(
        cls,
        *,
        command_type: str,
        payload: dict[str, Any] | None,
        client_id: str,
        role: RecordRole,
        participant_id: str | None,
        client_seq: int,
        command_id: str | None = None,
    ) -> RecordCommand:
        cleaned = validate_record_payload(command_type, payload or {})
        if command_type in {"Join", "UpdateName"} and role != "host":
            renamed = sanitize_display_name(cleaned.get("display_name"), guest=True)
            if not renamed:
                raise ValueError("display_name is required")
            cleaned["display_name"] = renamed
        pid = participant_id
        if command_type == "Join":
            pid = pid or cleaned.get("participant_id")
        return cls(
            type=command_type,  # type: ignore[arg-type]
            payload=cleaned,
            client_id=client_id,
            role=role,
            participant_id=pid,
            client_seq=client_seq,
            command_id=command_id or uuid4().hex,
        )


def authorize_record_command(
    *,
    role: RecordRole,
    capabilities: list[str],
    command_type: str,
) -> None:
    if command_type not in COMMAND_TYPES:
        raise ValueError(f"unknown record command type: {command_type}")
    if command_type in HOST_ONLY and role != "host":
        raise RecordAuthzError("host only")
    if command_type in REQUIRES_JOIN_CAP and role != "host" and CAP_JOIN not in capabilities:
        raise RecordAuthzError("join capability required")
    if command_type in REQUIRES_COMMENT_CAP and role != "host" and CAP_COMMENT not in capabilities:
        raise RecordAuthzError("comment capability required")
