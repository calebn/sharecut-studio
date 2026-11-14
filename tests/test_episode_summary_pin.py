from __future__ import annotations

import json
import shutil
from pathlib import Path

import multistream_media as media
from podcast_mcp.models import MediaAsset, Track, TrackRole
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.episode import EpisodeService
from podcast_mcp.services.document.episode_results import EpisodeSummary, StaleEpisodeSummary

FRESH = """{
  "name": "episode",
  "duration_sec": null,
  "tracks": [],
  "clip_count": 0,
  "pending_edits": 0,
  "chapters": 0,
  "applied_edits": 0,
  "reconciliation_stale": false
}"""

STALE = """{
  "name": "episode",
  "duration_sec": null,
  "tracks": [
    "host"
  ],
  "clip_count": 0,
  "pending_edits": 0,
  "chapters": 0,
  "applied_edits": 0,
  "reconciliation_stale": false,
  "stale_audio_streams": {
    "files": [
      {
        "path": "raw/st.mkv",
        "tracks": [
          "host"
        ],
        "audio_streams": 2,
        "old_pick": 1
      }
    ],
    "rerun": "Stale audio streams (several audio streams, analyzed from another stream than the first): raw/st.mkv. A file added since this fix was read correctly; if every listed file was added since, just run mark-streams-current. To fix, run `podcast pipeline run --from transcribe_tracks --retime-words --realign` (re-times words, then re-runs align_tracks, reconcile_transcript, analyze_prosody, the proposal steps, fill_gate_holes and balance_tracks in pipeline order), and re-enroll speaker profiles enrolled from the raw file (`podcast speaker enroll`); then run `podcast episode mark-streams-current --project PROJECT_FILE`."
  }
}"""


def _dump(ws: ProjectWorkspace) -> str:
    return json.dumps(EpisodeService(ws).summary().model_dump(), indent=2)


def _create(path: Path) -> ProjectWorkspace:
    with write_grant(WriteGrantKind.DISPATCHER):
        return ProjectWorkspace.create(path)


def _stale_workspace(tmp_path: Path) -> ProjectWorkspace:
    ws = _create(tmp_path / "ep")
    raw = ws.path.parent / "raw"
    raw.mkdir(exist_ok=True)
    stored = raw / "st.mkv"
    shutil.copy(media.multistream(tmp_path, "st.mkv"), stored)
    with write_grant(WriteGrantKind.DISPATCHER), ws.transaction() as project:
        project.meta.analysis_reads_first_audio_stream = False
        project.tracks.append(
            Track(
                id="host",
                label="host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/st.mkv", duration_sec=2.0),
            )
        )
        ws.save()
    return ws


def test_info_summary_of_a_fresh_episode_is_pinned(tmp_path):
    ws = _create(tmp_path / "ep")
    assert type(EpisodeService(ws).summary()) is EpisodeSummary
    assert _dump(ws) == FRESH


def test_info_summary_with_stale_multistream_media_is_pinned(tmp_path):
    ws = _stale_workspace(tmp_path)
    assert isinstance(EpisodeService(ws).summary(), StaleEpisodeSummary)
    assert _dump(ws) == STALE.replace("PROJECT_FILE", str(ws.path))
