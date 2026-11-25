from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer

_OPTIONAL_KEYS = (
    "gain_db",
    "fade_in_curve",
    "fade_out_curve",
    "off_speaker_mute_regions",
    "bleed_restore",
)


class ClipboardExtract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    source_start: float | int
    source_end: float | int
    relative_timeline_start: float | int
    source_id: str | None
    fade_in_ms: int
    fade_out_ms: int
    gain_db: float | None = None
    fade_in_curve: str | None = None
    fade_out_curve: str | None = None
    join_in_mode: str
    mute_regions: list[dict[str, Any]]
    off_speaker_mute_regions: list[dict[str, Any]] | None = None
    bleed_restore: dict[str, Any] | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_optionals(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        for key in _OPTIONAL_KEYS:
            if data.get(key) is None:
                data.pop(key, None)
        return data


class ClipboardResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    duration: float | int
    extracts: list[ClipboardExtract]
