from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RemovedChapter(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    removed: bool
    title: str


class DeletedChapter(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    deleted: bool
    time: float | int
    title: str
