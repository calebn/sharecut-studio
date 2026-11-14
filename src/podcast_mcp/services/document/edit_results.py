from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from podcast_mcp.edits.suggested_actions import SuggestedActionsResult


class SuggestedActionsApplied(BaseModel):
    """What one Apply suggested actions did; ``model_dump()`` is what the CLI and MCP print."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["apply_suggested_actions"] = "apply_suggested_actions"
    applied: dict[str, int]
    applied_count: int
    cut_over_speaker: int
    held: list[str]
    held_unsure: list[str]
    lowered_to_leave: int
    summary: str

    @classmethod
    def from_result(cls, result: SuggestedActionsResult) -> SuggestedActionsApplied:
        return cls(**result.to_payload())
