from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from podcast_mcp.services.document.join_quality_results import JoinQualityReport


class JoinLabelResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    label: dict[str, Any]
    played: bool
    features: JoinQualityReport


class JoinTrainResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    model: dict[str, Any]
    path: str
    n_labels: int
