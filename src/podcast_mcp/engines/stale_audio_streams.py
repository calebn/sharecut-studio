"""Projects whose analysis state was written before it read the first audio stream (#2131)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.engines.ffmpeg import AudioProbe
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.workspace_paths import resolve_under_workspace

RERUN_STEPS = (
    "`podcast pipeline run --from transcribe_tracks --retime-words --realign` (re-times words, "
    "then re-runs align_tracks, reconcile_transcript, analyze_prosody, the proposal steps, "
    "fill_gate_holes and balance_tracks in pipeline order), and re-enroll speaker profiles "
    "enrolled from the raw file (`podcast speaker enroll`)"
)


@dataclass(frozen=True)
class StaleStreamFile:
    path: str
    track_ids: tuple[str, ...]
    audio_streams: int
    old_pick: int | None


def stale_stream_files(
    project: EpisodeProject,
    *,
    probe: Callable[[Path], AudioProbe | None] = probe_media,
) -> list[StaleStreamFile]:
    """Multi-stream media whose old automatic pick was not the first audio stream.

    Empty for a project stamped as reading the first stream. Consolidated projects
    record only the mono WAVs, not the originals, so they are never flagged.
    """
    if project.meta.analysis_reads_first_audio_stream:
        return []
    tracks: dict[str, list[str]] = {}
    for track in project.tracks:
        if track.media is not None:
            tracks.setdefault(track.media.path, []).append(track.id)
    for source in project.sources:
        tracks.setdefault(source.path, [])
    found: list[StaleStreamFile] = []
    for stored, track_ids in tracks.items():
        try:
            resolved = resolve_under_workspace(project, stored)
        except ValueError:
            continue
        info = probe(resolved)
        if info is None or info.audio_stream_count < 2 or info.legacy_default_audio_index == 0:
            continue
        found.append(
            StaleStreamFile(
                path=stored,
                track_ids=tuple(track_ids),
                audio_streams=info.audio_stream_count,
                old_pick=info.legacy_default_audio_index,
            )
        )
    return found


def stale_stream_lines(project: EpisodeProject, found: list[StaleStreamFile]) -> list[str]:
    if not found:
        return []
    names = ", ".join(f.path for f in found)
    return [
        f"Stale audio streams (several audio streams, analyzed from another stream than "
        f"the first): {names}. A file added since this fix was read correctly; if every listed file was added "
        f"since, just run mark-streams-current. To fix, run {RERUN_STEPS}; then run "
        f"`podcast episode mark-streams-current --project {project.workspace_path() / 'episode.project.json'}`."
    ]
