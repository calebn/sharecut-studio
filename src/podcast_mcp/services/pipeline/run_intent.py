from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.util.project_state import FileRevision


@dataclass(frozen=True)
class PipelineRunIntent:
    project_path: Path
    config: dict[str, Any]
    from_step: str | None
    only_step: str | None
    skip_steps: tuple[str, ...]
    unattended: bool
    saved_revision: FileRevision


@dataclass(frozen=True)
class PipelineRetryUnavailable:
    reason: Literal["changed_targets", "unknown_revision"]
