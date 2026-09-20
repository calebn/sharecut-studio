"""Ephemeral WebRTC signaling on the record hub — never persisted."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from podcast_mcp.edits.share_capabilities import CAP_MONITOR
from podcast_mcp.services.record.commands import RecordAuthzError
from podcast_mcp.services.record.state import RecordRole
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.share import drop_absolute_path_strings

SIGNAL_SDP_MAX = 3500
SIGNAL_CANDIDATE_MAX = 512


class SignalDescription(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["offer", "answer", "pranswer", "rollback"]
    sdp: str = Field(min_length=1, max_length=SIGNAL_SDP_MAX)


class SignalCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate: str = Field(default="", max_length=SIGNAL_CANDIDATE_MAX)
    sdpMid: str | None = Field(default=None, max_length=64)
    sdpMLineIndex: int | None = Field(default=None, ge=0, le=32)
    usernameFragment: str | None = Field(default=None, max_length=64)


class SignalPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    to: str = Field(min_length=1, max_length=64)
    connected_wall_ms: int | None = Field(default=None, ge=0)
    description: SignalDescription | None = None
    candidate: SignalCandidate | None = None

    @model_validator(mode="after")
    def _one_kind(self) -> SignalPayload:
        if self.description is None and self.candidate is None:
            raise ValueError("signal requires description or candidate")
        if self.description is not None and self.candidate is not None:
            raise ValueError("signal cannot include description and candidate")
        return self


def validate_signal_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return SignalPayload.model_validate(payload or {}).model_dump(exclude_none=True)


def fanout_record_signal(
    hub_key: str,
    *,
    from_id: str,
    payload: dict[str, Any],
    role: RecordRole,
    capabilities: list[str] | None = None,
    roster_ids: set[str] | None = None,
) -> dict[str, Any]:
    if not from_id:
        raise ValueError("join_first")
    if role != "host" and CAP_MONITOR not in list(capabilities or []):
        raise RecordAuthzError("monitor capability required")
    cleaned = validate_signal_payload(payload)
    to_id = str(cleaned["to"])
    if to_id == from_id:
        raise ValueError("signal to self")
    if roster_ids is not None and to_id not in roster_ids:
        raise ValueError("unknown_peer")
    event = drop_absolute_path_strings(
        {
            "plane": "record",
            "type": "Signal",
            "from": from_id,
            "to": to_id,
            **{key: value for key, value in cleaned.items() if key != "to"},
        }
    )
    get_hub().publish(hub_key, event)
    return {
        "plane": "record",
        "type": "Echo",
        "command_type": "Signal",
        "participant_id": from_id,
    }
