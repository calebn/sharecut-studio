"""Host view and correction of which track each person's recordings land on."""

from __future__ import annotations

import re
from typing import Any

from podcast_mcp.edits.session_track_remap import remap_staged_participant
from podcast_mcp.engines.track_ids import slug_track_id
from podcast_mcp.models import EpisodeProject, SessionSuggestion
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.record.landing import record_source_id, room_tone_raw_rel
from podcast_mcp.services.record.landing_math import record_source_prefix
from podcast_mcp.services.record.service import RecordSessionService
from podcast_mcp.services.record.state import RecordSnapshot
from podcast_mcp.services.record.track_match import (
    TrackMatch,
    known_tracks,
    resolve_session_tracks,
    suggestion_for_session,
)
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError

NEW_TRACK = "new"


class RecordTrackService:
    """Plain-words track matches for the open room and the host's correction of one."""

    def __init__(self, workspace: ProjectWorkspace, session_id: str) -> None:
        self.workspace = workspace
        self.session_id = session_id
        self._room = RecordSessionService(workspace.project, session_id=session_id)

    def _matches(self, project: EpisodeProject) -> dict[str, TrackMatch]:
        snap = RecordSnapshot.model_validate(self._room.snapshot())
        return resolve_session_tracks(
            project, self.session_id, snap.participants, self._room.track_choices()
        )

    def matches(self) -> list[dict[str, Any]]:
        """Per recorded person: matched to an existing track, new, or ambiguous, in plain words."""
        self.workspace.reload()
        return [m.as_dict() for m in self._matches(self.workspace.project).values()]

    def assign(self, participant_id: str, track: str) -> dict[str, Any]:
        """Put a person's recordings on an existing track, or on a new one (``track="new"``).

        Allowed until the session is accepted or placed on the timeline. When their takes are
        already staged in a pending suggestion that is one undo step; before landing only the
        host's choice is kept. Refusals: ``unknown_participant``, ``unknown_track``,
        ``track_taken``, ``session_already_accepted``, ``session_skipped``.
        """
        self.workspace.reload()
        project = self.workspace.project
        current = self._matches(project)
        match = current.get(participant_id)
        if match is None:
            raise CodedKeyError(
                f"unknown participant: {participant_id}. List the people in this session to see "
                "their ids.",
                code="unknown_participant",
            )
        suggestion = suggestion_for_session(project, self.session_id)
        self._require_open(project, suggestion, match)
        target, label = self._target(project, current, match, track)
        if target == match.track_id:
            return {**match.as_dict(), "changed": False}
        sources = _own_sources(project, self.session_id, participant_id, suggestion)
        if suggestion is not None and (
            sources or _has_bed(suggestion, self.session_id, participant_id)
        ):
            title = f"Moved {match.display_name} to {label}"
            self.workspace.mutate(
                f"before {title}",
                f"after {title}",
                lambda p: remap_staged_participant(
                    p,
                    suggestion.id,
                    source_ids=sources,
                    bed_path=room_tone_raw_rel(self.session_id, participant_id),
                    track_id=target,
                    track_label=label,
                ),
                operation="remap_session_track",
                params={
                    "session_id": self.session_id,
                    "participant_id": participant_id,
                    "track_id": target,
                    "title": title,
                },
            )
        self._room.set_track_choice(participant_id, target)
        after = self._matches(self.workspace.project)[participant_id]
        return {**after.as_dict(), "changed": True}

    def _require_open(
        self, project: EpisodeProject, suggestion: SessionSuggestion | None, match: TrackMatch
    ) -> None:
        if suggestion is not None and suggestion.status == "accepted":
            raise CodedValueError(
                f"Session {suggestion.session_number} has already been accepted, so "
                f"{match.display_name}'s track can no longer be changed here. Move their clips "
                "in the edit instead.",
                code="session_already_accepted",
            )
        if suggestion is not None and suggestion.status == "skipped":
            raise CodedValueError(
                f"Session {suggestion.session_number} was skipped, so there is nothing to move.",
                code="session_skipped",
            )
        if suggestion is None and _on_timeline(project, self.session_id, match.participant_id):
            raise CodedValueError(
                f"{match.display_name}'s recordings are already on the timeline, so their track "
                "can no longer be changed here. Move their clips in the edit instead.",
                code="session_already_accepted",
            )

    def _target(
        self, project: EpisodeProject, current: dict[str, TrackMatch], match: TrackMatch, track: str
    ) -> tuple[str, str]:
        if track.strip().lower() == NEW_TRACK:
            target, label = slug_track_id(match.participant_id), match.display_name
        else:
            pool = known_tracks(
                project,
                self.session_id,
                (slug_track_id(pid) for pid in current),
            )
            if track not in pool:
                raise CodedKeyError(
                    f"unknown track: {track}. Use one of: {', '.join(sorted(pool)) or 'none yet'}, "
                    'or "new" for a new track.',
                    code="unknown_track",
                )
            target, label = track, pool[track]
        for other in current.values():
            if other.participant_id != match.participant_id and other.track_id == target:
                raise CodedValueError(
                    f'{other.display_name} is already on "{other.track_label}". Move them first, '
                    "or choose another track.",
                    code="track_taken",
                )
        return target, label


def _own_sources(
    project: EpisodeProject,
    session_id: str,
    participant_id: str,
    suggestion: SessionSuggestion | None,
) -> set[str]:
    if suggestion is None:
        return set()
    return {
        take.source_id
        for take in suggestion.takes
        if take.source_id
        == record_source_id(session_id, take.take_index, participant_id, take.segment_index)
    }


def _has_bed(suggestion: SessionSuggestion, session_id: str, participant_id: str) -> bool:
    path = room_tone_raw_rel(session_id, participant_id)
    return any(bed.path == path for bed in suggestion.room_tone)


def _on_timeline(project: EpisodeProject, session_id: str, participant_id: str) -> bool:
    pattern = re.compile(
        rf"^{re.escape(record_source_prefix(session_id))}\d+-{re.escape(participant_id)}-\d+$"
    )
    return any(pattern.match(clip.source_id or "") for clip in project.clips)
