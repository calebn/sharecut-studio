from __future__ import annotations

import json
from pathlib import Path

from podcast_mcp.models import EpisodeProject, load_project, project_file_path, save_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.project_state import project_commit_lock


class ProjectStore:
    """Single API for loading and committing episode.project.json."""

    def __init__(self, project_path: Path | str) -> None:
        self.project_path = Path(project_path).expanduser().resolve()
        if self.project_path.is_dir():
            self.project_path = project_file_path(self.project_path)

    def load(self) -> EpisodeProject:
        project = load_project(self.project_path)
        self.adopt_history_index(project)
        return project

    def commit(self, project: EpisodeProject) -> Path:
        with project_commit_lock(project):
            self._sync_history_index_to_project(project)
            path = save_project(project, self.project_path)
            self._mirror_transcript_cache(project)
            return path

    def reload(self, project: EpisodeProject) -> EpisodeProject:
        loaded = self.load()
        project.__dict__.update(loaded.model_dump())
        return project

    def adopt_history_index(self, project: EpisodeProject) -> bool:
        """Fill an empty in-memory history from ``history/index.json`` if one exists."""
        index_path = project.workspace_path() / "history" / "index.json"
        if not project.history.is_empty() or not index_path.is_file():
            return False
        data = json.loads(index_path.read_text(encoding="utf-8"))
        project.history = ProjectHistory.model_validate(data)
        return True

    def _sync_history_index_to_project(self, project: EpisodeProject) -> None:
        """Mirror history to ``history/index.json``; an empty one adopts the index instead."""
        if self.adopt_history_index(project):
            return
        index_path = project.workspace_path() / "history" / "index.json"
        if index_path.parent.exists() or not project.history.is_empty():
            index_path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(index_path, project.history.model_dump(mode="json"))

    def _mirror_transcript_cache(self, project: EpisodeProject) -> None:
        """Write-through optional caches; canonical data lives in episode.project.json."""
        combined = project.transcript_data.combined
        if combined and combined.utterances:
            out = project.transcripts_dir() / "combined.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(combined.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
        for transcript in project.transcript_data.per_track:
            if not transcript.words:
                continue
            cache = project.transcripts_dir() / f"{transcript.track_id}.json"
            cache.write_text(transcript.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
