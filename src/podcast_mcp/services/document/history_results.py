from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _HistoryResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class HistoryStatusResult(_HistoryResult):
    cursor: int
    total: int
    can_undo: bool
    can_redo: bool
    current_label: str | None
    head_id: str


class HistoryEntryResult(_HistoryResult):
    index: int
    id: str
    label: str
    created_at: str
    operation: str | None
    params: dict[str, Any] | None
    current: bool


class SnapshotHistoryGroup(_HistoryResult):
    kind: Literal["snapshot"] = "snapshot"
    index: int
    id: str
    label: str
    operation: str | None
    params: dict[str, Any] | None
    created_at: str
    title: str


class MutationHistoryGroup(_HistoryResult):
    kind: Literal["mutation"] = "mutation"
    before_index: int
    after_index: int
    before_id: str
    after_id: str
    label: str
    operation: str | None
    params: dict[str, Any] | None
    created_at: str
    title: str


HistoryGroup = Annotated[
    SnapshotHistoryGroup | MutationHistoryGroup,
    Field(discriminator="kind"),
]


class HistoryListResult(_HistoryResult):
    cursor: int
    head_id: str
    can_undo: bool
    can_redo: bool
    entries: list[HistoryEntryResult]
    groups: list[HistoryGroup]
