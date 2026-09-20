from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.track_ids import slug_track_id
from podcast_mcp.edits.track_media import (
    apply_full_span_media,
    ensure_audio_in_workspace,
    refresh_timeline_duration,
)
from podcast_mcp.engines.peaks import schedule_track_peaks
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.models import Track, TrackRole
from podcast_mcp.services.workspace import ProjectWorkspace


class EpisodeService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def add_track(
        self,
        track_id: str,
        file_path: str,
        *,
        role: str = "dialogue",
        speaker: str | None = None,
        label: str | None = None,
    ) -> str:
        track_id = slug_track_id(track_id)
        audio_in = Path(file_path).expanduser().resolve()
        if not audio_in.is_file():
            raise FileNotFoundError(f"audio file not found: {audio_in}")
        audio, store = ensure_audio_in_workspace(Path(self.ws.project.workspace_dir), audio_in)

        def mutate(p) -> None:
            track = Track(
                id=track_id,
                label=label or track_id,
                role=TrackRole(role),
                speaker=speaker or track_id,
            )
            p.tracks = [t for t in p.tracks if t.id != track_id]
            p.tracks.append(track)
            apply_full_span_media(p, track, store_path=store, audio_path=audio)
            record_invalidation(p, track_ids=[track_id], reason="other")

        self.ws.mutate(
            f"before add track {track_id}",
            f"after add track {track_id}",
            mutate,
            operation="add_track",
            params={"track_id": track_id, "file_path": store},
        )
        track = self.ws.project.track_by_id(track_id)
        if track is not None:
            schedule_track_peaks(self.ws.project, track)
        return f"Added track {track_id}"

    def add_empty_track(
        self,
        track_id: str,
        *,
        role: str = "dialogue",
        speaker: str | None = None,
        label: str | None = None,
    ) -> dict:
        track_id = slug_track_id(track_id)
        if self.ws.project.track_by_id(track_id) is not None:
            raise ValueError(f"track already exists: {track_id}")

        def mutate(p) -> None:
            p.tracks.append(
                Track(
                    id=track_id,
                    label=label or track_id,
                    role=TrackRole(role),
                    speaker=speaker or track_id,
                    media=None,
                )
            )

        self.ws.mutate(
            f"before add empty track {track_id}",
            f"after add empty track {track_id}",
            mutate,
            operation="add_empty_track",
            params={"track_id": track_id},
        )
        return {"track_id": track_id, "label": label or track_id, "role": role}

    def set_track_media(self, track_id: str, file_path: str) -> dict:
        audio_in = Path(file_path).expanduser().resolve()
        if not audio_in.is_file():
            raise FileNotFoundError(f"audio file not found: {audio_in}")
        if self.ws.project.track_by_id(track_id) is None:
            raise ValueError(f"unknown track: {track_id}")
        audio, store = ensure_audio_in_workspace(Path(self.ws.project.workspace_dir), audio_in)

        def mutate(p) -> None:
            track = p.track_by_id(track_id)
            if track is None:
                raise ValueError(f"unknown track: {track_id}")
            apply_full_span_media(p, track, store_path=store, audio_path=audio)
            record_invalidation(p, track_ids=[track_id], reason="other")

        self.ws.mutate(
            f"before set track media {track_id}",
            f"after set track media {track_id}",
            mutate,
            operation="set_track_media",
            params={"track_id": track_id, "file_path": store},
        )
        track = self.ws.project.track_by_id(track_id)
        assert track is not None and track.media is not None
        schedule_track_peaks(self.ws.project, track)
        return {
            "track_id": track_id,
            "media_path": track.media.path,
            "duration_sec": track.media.duration_sec,
        }

    def set_track_meta(
        self,
        track_id: str,
        *,
        label: str | None = None,
        role: str | None = None,
        speaker: str | None = None,
    ) -> dict:
        if self.ws.project.track_by_id(track_id) is None:
            raise ValueError(f"unknown track: {track_id}")
        if label is None and role is None and speaker is None:
            raise ValueError("set_track_meta requires at least one of label, role, speaker")

        def mutate(p) -> None:
            track = p.track_by_id(track_id)
            if track is None:
                raise ValueError(f"unknown track: {track_id}")
            if label is not None:
                track.label = label
            if role is not None:
                track.role = TrackRole(role)
            if speaker is not None:
                track.speaker = speaker

        self.ws.mutate(
            f"before set track meta {track_id}",
            f"after set track meta {track_id}",
            mutate,
            operation="set_track_meta",
            params={"track_id": track_id, "label": label, "role": role, "speaker": speaker},
        )
        track = self.ws.project.track_by_id(track_id)
        assert track is not None
        return {
            "track_id": track_id,
            "label": track.label,
            "role": track.role.value if hasattr(track.role, "value") else str(track.role),
            "speaker": track.speaker,
        }

    def remove_track(self, track_id: str) -> dict:
        if self.ws.project.track_by_id(track_id) is None:
            raise ValueError(f"unknown track: {track_id}")

        def mutate(p) -> None:
            p.tracks = [t for t in p.tracks if t.id != track_id]
            p.clips = [c for c in p.clips if c.track_id != track_id]
            p.transcripts = [t for t in p.transcripts if t.track_id != track_id]
            p.processing_chains = [c for c in p.processing_chains if c.track_id != track_id]
            p.automation_envelopes = [e for e in p.automation_envelopes if e.track_id != track_id]
            refresh_timeline_duration(p)
            record_invalidation(p, track_ids=[track_id], reason="other")

        self.ws.mutate(
            f"before remove track {track_id}",
            f"after remove track {track_id}",
            mutate,
            operation="remove_track",
            params={"track_id": track_id},
        )
        return {"track_id": track_id, "removed": True}

    def reorder_track(self, track_id: str, index: int) -> dict:
        """Move ``track_id`` to 0-based position ``index`` in ``timeline.tracks``."""
        if self.ws.project.track_by_id(track_id) is None:
            raise ValueError(f"unknown track: {track_id}")

        def mutate(p) -> None:
            tracks = list(p.tracks)
            current = next(i for i, t in enumerate(tracks) if t.id == track_id)
            track = tracks.pop(current)
            dest = max(0, min(int(index), len(tracks)))
            tracks.insert(dest, track)
            p.tracks = tracks

        self.ws.mutate(
            f"before reorder track {track_id}",
            f"after reorder track {track_id}",
            mutate,
            operation="reorder_track",
            params={"track_id": track_id, "index": index},
        )
        order = [t.id for t in self.ws.project.tracks]
        return {
            "track_id": track_id,
            "index": order.index(track_id),
            "track_ids": order,
        }
