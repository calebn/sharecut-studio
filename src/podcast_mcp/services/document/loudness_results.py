from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
)


class DialogueBalance(BaseModel):
    """Measurement freshness of one dialogue track."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    stale: bool | None
    speech_gated: bool | None
    measured_lufs: float | None


class LoudnessReport(BaseModel):
    """Loudness verdict plus artifact freshness; ``balance`` is absent for untracked audio."""

    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, serialize_by_alias=True
    )

    path: str
    measured_lufs: float | None
    target_lufs: float
    true_peak_limit_db: float
    lufs_pass: bool
    passed: bool = Field(alias="pass")
    stale: bool | None
    stale_reason: str | None
    balance: dict[str, DialogueBalance] | None = None

    @model_serializer(mode="wrap")
    def _drop_unset_balance(self, handler: SerializerFunctionWrapHandler) -> Any:
        data: dict[str, Any] = handler(self)
        if data.get("balance") is None:
            data.pop("balance", None)
        return data


def build_loudness_report(
    measured: Mapping[str, Any],
    *,
    stale: bool | None,
    stale_reason: str | None,
    balance: Mapping[str, Mapping[str, Any]] | None,
) -> LoudnessReport:
    return LoudnessReport(
        **measured,
        stale=stale,
        stale_reason=stale_reason,
        balance=None if balance is None else {k: DialogueBalance(**v) for k, v in balance.items()},
    )
