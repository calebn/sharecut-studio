from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class WordSuppressedResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    source_id: str | None
    word_index: int
    suppressed: bool
    text: str


class WordAutomaticResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    source_id: str | None
    word_index: int
    suppressed: bool
    audibility_locked: bool
    text: str


class WordsIgnoredResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    source_id: str | None
    start_word_index: int
    end_word_index: int
    ignored: bool
    changed: int
