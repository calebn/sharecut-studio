"""One-shot upgrade of a saved project workspace from an older format version."""

from __future__ import annotations

import json
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject, load_project
from podcast_mcp.models.episode import EPISODE_PROJECT_FILENAME
from podcast_mcp.models.project_format import SUPPORTED_PROJECT_VERSION
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.project_state import project_commit_lock

Step = Callable[[dict[str, Any]], None]


def _add_timeline_join_fade_default(data: dict[str, Any]) -> None:
    """2.0 to 2.1: ``timeline.join_fade_max_ms`` is new and absent means the app default."""


STEPS: dict[str, tuple[str, Step]] = {"2.0": ("2.1", _add_timeline_join_fade_default)}


@dataclass(frozen=True)
class UpgradeResult:
    project: Path
    from_version: str
    to_version: str


def upgrade_workspace(project_file: Path, output_dir: Path) -> UpgradeResult:
    """Copy the workspace of *project_file* to the new *output_dir* at the current format.

    The old file is read as plain JSON, never opened as a project. The source is left
    unchanged; history, snapshots and media are copied byte for byte. The output appears
    only when its upgraded project loads.
    """
    project_file = Path(project_file)
    output_dir = Path(output_dir)
    if project_file.name != EPISODE_PROJECT_FILENAME or not project_file.is_file():
        raise CodedValueError(
            f"--project must name an existing {EPISODE_PROJECT_FILENAME} file",
            code="upgrade_source_invalid",
        )
    source_dir = project_file.parent.resolve()
    target = output_dir.resolve()
    if target.exists() or target.is_relative_to(source_dir) or source_dir.is_relative_to(target):
        raise CodedValueError(
            "--output must be a new directory outside the source workspace",
            code="upgrade_output_invalid",
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f".{target.name}.upgrading-{uuid.uuid4().hex[:8]}"
    lock_key = EpisodeProject.create(source_dir.name, str(source_dir))
    try:
        with project_commit_lock(lock_key):
            data = _read_document(project_file)
            from_version = _upgrade_document(data, project_file)
            shutil.copytree(source_dir, staging, symlinks=True, ignore=_skip_lock_files)
        write_text_atomic(
            staging / EPISODE_PROJECT_FILENAME,
            json.dumps(data, indent=2, ensure_ascii=False),
            creation_mode=0o666,
        )
        load_project(staging / EPISODE_PROJECT_FILENAME)
        staging.rename(target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return UpgradeResult(target / EPISODE_PROJECT_FILENAME, from_version, SUPPORTED_PROJECT_VERSION)


def _upgrade_document(data: dict[str, Any], project_file: Path) -> str:
    from_version = str(data.get("version"))
    version = from_version
    if version == SUPPORTED_PROJECT_VERSION:
        raise CodedValueError(
            f"{project_file} is already at version {SUPPORTED_PROJECT_VERSION}",
            code="upgrade_not_needed",
        )
    while version != SUPPORTED_PROJECT_VERSION:
        if version not in STEPS:
            raise CodedValueError(
                f"Cannot upgrade project version {version!r} to {SUPPORTED_PROJECT_VERSION!r}",
                code="upgrade_unsupported_version",
            )
        version, step = STEPS[version]
        step(data)
        data["version"] = version
    return from_version


def _skip_lock_files(directory: str, names: list[str]) -> list[str]:
    return [name for name in names if name.endswith(".lock") and Path(directory).name == "artifacts"]


def _read_document(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CodedValueError(
            f"{path} is not a readable project file", code="upgrade_source_invalid"
        ) from exc
    if not isinstance(data, dict) or "timeline" not in data:
        raise CodedValueError(f"{path} is not a project file", code="upgrade_source_invalid")
    return data
