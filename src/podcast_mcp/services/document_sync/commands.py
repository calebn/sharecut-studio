"""Typed document-plane commands. Separate from transport."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import uuid4

from podcast_mcp.models import CutIntent
from podcast_mcp.services.session_sync import ClientRole

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
    "ApplySuggestedActions",
    "UpdatePendingEdit",
    "RestoreAppliedEdit",
    "RestoreClipBleed",
    "SetClipFade",
    "TrimClipEdge",
    "RollClipJoin",
    "SetJoinMode",
    "SetClipJoin",
    "ApplyFadeRecommendations",
    "ApplyFadeRecommendationList",
    "SetEffectBypass",
    "AddEffect",
    "ReconcileTranscript",
    "SuppressBleed",
    "SuppressLowAudibility",
    "SetBleedAlignmentMode",
    "RemoveEffect",
    "ReplaceTranscriptMatches",
    "CorrectTranscriptWord",
    "ApplyTranscriptCleanup",
    "VerifyTranscript",
    "CorrectTranscriptPhrase",
    "SetTranscriptWordSuppressed",
    "SetTranscriptWordAutomatic",
    "SetTranscriptWordsIgnored",
    "SetTranscriptWordTiming",
    "AddChapter",
    "UpdateChapter",
    "DeleteChapter",
    "AddSocialClip",
    "UpdateSocialClip",
    "DeleteSocialClip",
    "SetEnvelope",
    "EditSelectedRange",
    "SuggestPendingEdit",
    "StageTimeRangeCut",
    "StageTextMatchCut",
    "StageUtteranceCut",
    "StageWordsCut",
    "SplitAtTime",
    "DeleteClip",
    "DuplicateSegment",
    "MoveSegment",
    "InsertGap",
    "FillRoomTone",
    "ApplyAutoEdits",
    "ApplyEditPlan",
    "ShortenWordGaps",
    "StripSilence",
    "FadeJoins",
    "CrossfadeJoins",
    "MoveByText",
    "MoveClips",
    "PasteSegment",
    "CutRange",
    "RippleDeleteText",
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


@dataclass(frozen=True)
class TrustedCommandContext:
    """Origin facts that only a server-side command adapter may establish."""

    boundary_intent: CutIntent = CutIntent.PROGRAMMATIC


PROGRAMMATIC_COMMAND = TrustedCommandContext()
INTERACTIVE_COMMAND = TrustedCommandContext(boundary_intent=CutIntent.HUMAN_BOUNDARIES)


def command_context_for_role(role: ClientRole) -> TrustedCommandContext:
    """Only the host's own viewer role stamps a human cut; every other actor is programmatic."""
    return INTERACTIVE_COMMAND if role == "viewer" else PROGRAMMATIC_COMMAND
