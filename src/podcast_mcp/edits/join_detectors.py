"""Typed detector results at the join-continuity orchestration boundary."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class DetectorHit:
    name: str
    score: float
    weight: float
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "score": round(self.score, 4),
            "weight": round(self.weight, 4),
            "detail": self.detail,
        }


class JoinDetector(Protocol):
    """Adapter contract for a detector whose input has already been prepared."""

    def detect(self) -> list[DetectorHit]: ...
