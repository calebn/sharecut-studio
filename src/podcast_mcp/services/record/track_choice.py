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
from podcast_mcp.services.record.state import RecordSnapshot, find_participant
from podcast_mcp.services.record.track_match import (
    TrackMatch,
    held_tracks,
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
        ``track_taken``, ``replace_target_track``, ``participant_removed``,
        ``session_already_accepted``, ``session_skipped``.
        """
        with self.workspace.transaction() as project:
            current = self._matches(project)
            match = current.get(participant_id)
            if match is None:
                raise CodedKeyError(
                    f"Unknown participant: {participant_id}. Run `podcast record tracks` "
                    "(record_tracks_tool) to list the people in this session and their ids.",
                    code="unknown_participant",
                )
            suggestion = suggestion_for_session(project, self.session_id)
            self._require_open(project, suggestion, match)
            held = held_tracks(project, self.session_id)
            person = find_participant(
                RecordSnapshot.model_validate(self._room.snapshot()), participant_id
            )
            if person is not None and person.removed and participant_id not in held:
                raise CodedValueError(
                    f"{match.display_name} was removed from this session, so their track cannot "
                    "be changed.",
                    code="participant_removed",
                )
            target, label = self._target(project, current, match, track, held)
            sources = _own_sources(project, self.session_id, participant_id, suggestion)
            has_staged_recording = suggestion is not None and (
                bool(sources) or _has_bed(suggestion, self.session_id, participant_id)
            )
            if target == match.track_id:
                if not has_staged_recording:
                    self._room.set_track_choice(participant_id, target)
                    match = self._matches(self.workspace.project)[participant_id]
                return {**match.as_dict(), "changed": False}
            if not has_staged_recording:
                self._require_target_stays(match)
            follows = bool(
                suggestion is not None
                and has_staged_recording
                and suggestion.kind == "replace"
                and match.track_id in suggestion.track_ids
            )
            if (
                follows
                and suggestion is not None
                and target != match.track_id
                and target in suggestion.track_ids
            ):
                raise CodedValueError(
                    f'This replace already covers "{label}". Choose a track it does not cover, '
                    "or change the session target instead.",
                    code="replace_target_track",
                )
            if suggestion is not None and has_staged_recording:
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
                        old_track_id=match.track_id,
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
            out = {**after.as_dict(), "changed": True}
            if follows:
                covered = (
                    f'"{label}" on its new track'
                    if label == match.track_label
                    else f'"{label}" instead of "{match.track_label}"'
                )
                out["note"] = f"This replace now covers {covered}; it follows {match.display_name}."
            return out

    def _require_target_stays(self, match: TrackMatch) -> None:
        """A replace room names the tracks it covers; their person cannot leave before staging."""
        target = RecordSnapshot.model_validate(self._room.snapshot()).target
        if target.kind == "replace" and match.track_id in target.track_ids:
            raise CodedValueError(
                f'This session replaces audio on "{match.track_label}", which is where '
                f"{match.display_name} is recorded. Change the session target instead, or move "
                "them after their takes are staged.",
                code="replace_target_track",
            )

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
        self,
        project: EpisodeProject,
        current: dict[str, TrackMatch],
        match: TrackMatch,
        track: str,
        held: dict[str, str],
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
                names = ", ".join(f'"{label}" ({tid})' for tid, label in sorted(pool.items()))
                raise CodedKeyError(
                    f"Unknown track: {track}. Use one of: {names or 'none yet'}, "
                    'or "new" for a new track.',
                    code="unknown_track",
                )
            target, label = track, pool[track]
        removed = {
            p.participant_id
            for p in RecordSnapshot.model_validate(self._room.snapshot()).participants
            if p.removed
        }
        for other in current.values():
            if other.participant_id in removed and other.participant_id not in held:
                continue
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
    bed = room_tone_raw_rel(session_id, participant_id)
    return any(pattern.match(clip.source_id or "") for clip in project.clips) or any(
        track.room_tone is not None and track.room_tone.path == bed for track in project.tracks
    )
