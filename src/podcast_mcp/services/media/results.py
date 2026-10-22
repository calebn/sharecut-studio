from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _WaveformResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class WaveformLevel(_WaveformResult):
    spp: int
    bins: int


class ReadyWaveformEntry(_WaveformResult):
    status: Literal["ready"] = "ready"
    key: str
    sample_rate: int
    channels: int
    total_frames: int
    base_spp: int
    level_factor: int
    bins_per_tile: int
    levels: list[WaveformLevel]


class GeneratingWaveformEntry(_WaveformResult):
    status: Literal["generating"] = "generating"


class UnavailableWaveformEntry(_WaveformResult):
    status: Literal["unavailable"] = "unavailable"
    reason: str


WaveformEntry = Annotated[
    ReadyWaveformEntry | GeneratingWaveformEntry | UnavailableWaveformEntry,
    Field(discriminator="status"),
]


class WaveformStatusResult(_WaveformResult):
    format_version: int
    media: dict[str, WaveformEntry]
