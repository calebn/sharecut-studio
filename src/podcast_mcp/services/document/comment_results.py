from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from podcast_mcp.models.episode import CommentActionItem, CommentReply


class _CommentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CommentDeletedResult(_CommentResult):
    deleted: bool
    id: str


class CommentActionItemResult(_CommentResult):
    comment_id: str
    action_item: CommentActionItem


class CommentReplyResult(_CommentResult):
    comment_id: str
    reply: CommentReply
