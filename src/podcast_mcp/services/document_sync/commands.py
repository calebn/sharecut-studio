"""Typed document-plane commands. Separate from transport."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import uuid4

ClientRole = Literal["agent", "viewer", "cli", "guest"]

DocumentCommandType = Literal[
    "AddComment",
    "UpdateComment",
    "ResolveComment",
    "DeleteComment",
    "AddReply",
    "SetActionDone",
    "AddAction",
    "UndoHistory",
    "RedoHistory",
    "ApproveEdits",
    "RejectEdits",
    "UpdatePendingEdit",
    "RestoreAppliedEdit",
    "SetClipFade",
    "TrimClipEdge",
    "RollClipJoin",
    "SetJoinMode",
    "ApplyFadeRecommendations",
    "SetEffectBypass",
    "CorrectTranscriptWord",
    "CorrectTranscriptPhrase",
    "SetTranscriptWordSuppressed",
    "AddChapter",
    "UpdateChapter",
    "DeleteChapter",
    "AddSocialClip",
    "UpdateSocialClip",
    "DeleteSocialClip",
    "SetEnvelope",
    "SuggestPendingEdit",
    "SplitAtTime",
    "DeleteClip",
    "RippleDeleteClip",
    "DuplicateSegment",
    "MoveSegment",
    "MoveClips",
    "PasteSegment",
    "RippleDeleteRange",
    "AddTrack",
    "SetTrackMedia",
    "SetTrackMeta",
    "SetTrackFader",
    "SetTrackMute",
    "RemoveTrack",
    "ReorderTrack",
]


@dataclass
class DocumentCommand:
    type: DocumentCommandType
    payload: dict[str, Any]
    client_id: str
    role: ClientRole
    client_seq: (
        int | None
    )  # None: the server assigns a negative sequence (host MCP/CLI, remote MCP)
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
