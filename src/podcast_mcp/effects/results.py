from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class _EffectResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AddEffectResult(_EffectResult):
    track_id: str
    effects: list[dict[str, Any]]


class RemoveEffectResult(_EffectResult):
    track_id: str
    removed: int


class EffectBypassResult(_EffectResult):
    track_id: str
    effect_index: int
    bypass: bool
    effect: str
    effects: list[dict[str, Any]]


class EffectTrackListResult(_EffectResult):
    track_id: str
    effects: list[dict[str, Any]]
    supported_effects: list[str]


class EffectPresetListResult(_EffectResult):
    presets: list[str]
    supported_effects: list[str]
