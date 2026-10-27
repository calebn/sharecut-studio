"""Which track a person's recordings land on: a returning person is matched to their track by name.

Resolution order for one recorded participant of a session, first hit wins:

1. *held*: their takes of this session are already staged or on the timeline, so they stay put;
2. *host choice*: the host moved them (``RecordSessionService.set_track_choice``);
3. *own track*: a track with their participant-id slug exists (the host keeps ``p_host``);
4. *name*: exactly one existing dialogue track has their name (case, accents and spacing
   ignored) and nobody else in the session has that name;
5. otherwise a new track. Two people sharing a name, or two existing tracks sharing it, are
   never merged silently: the result is ``ambiguous`` and each gets a new track until the host
   picks.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from functools import partial
from typing import Literal

from podcast_mcp.edits.session_suggestions import list_session_suggestions
from podcast_mcp.engines.track_ids import slug_track_id
from podcast_mcp.models import EpisodeProject, SessionSuggestion, TrackRole
from podcast_mcp.services.record.landing_math import record_source_prefix
from podcast_mcp.services.record.state import RECORDED_ROLES, ParticipantState

MatchStatus = Literal["matched", "new", "ambiguous"]
_SPACES = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    """Compare key for a display name: no accents, any case, one space between words."""
    folded = unicodedata.normalize("NFKD", name)
    bare = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return _SPACES.sub(" ", bare).strip().casefold()


@dataclass(frozen=True)
class TrackMatch:
    participant_id: str
    display_name: str
    role: str
    status: MatchStatus
    track_id: str
    track_label: str
    reason: str
    message: str
    candidates: tuple[tuple[str, str], ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {
            "participant_id": self.participant_id,
            "display_name": self.display_name,
            "role": self.role,
            "status": self.status,
            "track_id": self.track_id,
            "track_label": self.track_label,
            "reason": self.reason,
            "message": self.message,
            "candidates": [{"track_id": tid, "label": label} for tid, label in self.candidates],
        }


def held_tracks(project: EpisodeProject, session_id: str) -> dict[str, str]:
    """Participant id to the track their takes of this session are already staged or placed on."""
    prefix = record_source_prefix(session_id)
    pid_of = re.compile(rf"^{re.escape(prefix)}\d+-(.+)-\d+$")
    on_track: dict[str, str] = {}
    suggestion = next(
        (s for s in list_session_suggestions(project) if s.session_id == session_id), None
    )
    if suggestion is not None:
        for take in suggestion.takes:
            on_track[take.source_id] = take.track_id
    for clip in project.clips:
        if clip.source_id and clip.source_id.startswith(prefix):
            on_track[clip.source_id] = clip.track_id
    held: dict[str, str] = {}
    for source_id, track_id in on_track.items():
        found = pid_of.match(source_id)
        if found:
            held[found.group(1)] = track_id
    return held


def _other_staged_tracks(project: EpisodeProject, session_id: str) -> dict[str, str]:
    """Tracks pending suggestions of other sessions will create (id to label)."""
    out: dict[str, str] = {}
    for row in list_session_suggestions(project, status="pending"):
        if row.session_id != session_id:
            out.update({take.track_id: take.track_label for take in row.takes})
    return out


def known_tracks(
    project: EpisodeProject, session_id: str, own_ids: Iterable[str]
) -> dict[str, str]:
    """Existing dialogue tracks a person can return to (id to label), this session's own aside.

    A track this session itself created (a fresh participant slug carrying nothing from before)
    is left out, so a person is never matched to their own new track.
    """
    prefix = record_source_prefix(session_id)
    outside = {c.track_id for c in project.clips if not (c.source_id or "").startswith(prefix)}
    staged = _other_staged_tracks(project, session_id)
    outside |= set(staged)
    own = set(own_ids)
    pool = {
        t.id: t.label
        for t in project.timeline.tracks
        if t.role == TrackRole.DIALOGUE and (t.id not in own or t.id in outside)
    }
    for track_id, label in staged.items():
        pool.setdefault(track_id, label)
    return pool


def resolve_session_tracks(
    project: EpisodeProject,
    session_id: str,
    people: Iterable[ParticipantState],
    choices: Mapping[str, str],
) -> dict[str, TrackMatch]:
    """The track every recorded participant of ``session_id`` lands on, with plain-words reasons."""
    recorded = [p for p in people if p.role in RECORDED_ROLES]
    pool = known_tracks(project, session_id, (slug_track_id(p.participant_id) for p in recorded))
    held = held_tracks(project, session_id)
    labels = {t.id: t.label for t in project.timeline.tracks} | pool
    by_name: dict[str, list[str]] = {}
    for track_id, label in pool.items():
        by_name.setdefault(normalize_name(label), []).append(track_id)
    # Only people who are still here, or whose takes are already in, can make a name ambiguous.
    people_by_name: dict[str, int] = {}
    for p in recorded:
        if not p.removed or p.participant_id in held:
            key = normalize_name(p.display_name)
            people_by_name[key] = people_by_name.get(key, 0) + 1

    def build(
        p: ParticipantState,
        status: MatchStatus,
        track_id: str,
        reason: str,
        message: str,
        candidates: tuple[tuple[str, str], ...] = (),
    ) -> TrackMatch:
        label = labels.get(track_id) or p.display_name or p.participant_id
        return TrackMatch(
            p.participant_id, p.display_name, p.role, status, track_id, label, reason, message,
            candidates,
        )  # fmt: skip

    def settled(p: ParticipantState, track_id: str, reason: str, how: str) -> TrackMatch:
        who = p.display_name or "This person"
        if track_id in pool:
            return build(
                p,
                "matched",
                track_id,
                reason,
                f'{who} {how} the existing track "{pool[track_id]}".',
            )
        if reason == "own_track":
            return build(p, "new", track_id, reason, f"{who} keeps their own track.")
        return build(p, "new", track_id, reason, f"{who} {how} a new track.")

    # Strongest claim first (held, host choice, own track); a track goes to one person only.
    out: dict[str, TrackMatch] = {}
    claimed: set[str] = set()
    gone: set[str] = set()

    def claim(p: ParticipantState, track_id: str, reason: str, how: str) -> None:
        if track_id not in claimed:
            claimed.add(track_id)
            out[p.participant_id] = settled(p, track_id, reason, how)

    for p in recorded:
        if p.participant_id in held:
            claim(p, held[p.participant_id], "held", "is already recorded in this session on")
    for p in recorded:
        chosen = choices.get(p.participant_id)
        if chosen is None or p.participant_id in out:
            continue
        if chosen == slug_track_id(p.participant_id) or chosen in labels:
            claim(p, chosen, "host_choice", "was moved there by the host, onto")
        else:
            gone.add(p.participant_id)
    for p in recorded:
        own = slug_track_id(p.participant_id)
        if p.participant_id not in out and project.track_by_id(own) is not None:
            claim(p, own, "own_track", "stays on")
    for p in recorded:
        if p.participant_id in out:
            continue
        match = _by_name(
            p.display_name, slug_track_id(p.participant_id), pool, by_name, people_by_name,
            claimed, partial(build, p),
        )  # fmt: skip
        if p.participant_id in gone:
            note = " The track the host chose for them is gone, so this was worked out again."
            match = replace(match, message=match.message + note)
        out[p.participant_id] = match
        claimed.add(match.track_id)
    return {p.participant_id: out[p.participant_id] for p in recorded}


def _by_name(
    name: str,
    fresh: str,
    pool: Mapping[str, str],
    by_name: Mapping[str, list[str]],
    people_by_name: Mapping[str, int],
    claimed: set[str],
    build: Callable[..., TrackMatch],
) -> TrackMatch:
    key = normalize_name(name)
    same = by_name.get(key, []) if key else []
    found = tuple((tid, pool[tid]) for tid in same)
    who = name or "This person"
    if key and people_by_name.get(key, 0) > 1:
        return build(
            "ambiguous",
            fresh,
            "duplicate_name",
            f"More than one person in this session is called {name}, so none of them was matched "
            "to an existing track and each gets a new one. Put each on the right track by hand.",
            found,
        )
    if not same:
        return build("new", fresh, "new", f"{who} is new here, so they get a new track.")
    if len(same) > 1:
        return build(
            "ambiguous",
            fresh,
            "several_tracks",
            f"{len(same)} existing tracks are called {name}, so {name} was not matched and gets a "
            "new track. Put them on the right one by hand.",
            found,
        )
    if same[0] in claimed:
        return build(
            "ambiguous",
            fresh,
            "track_in_use",
            f'The track "{pool[same[0]]}" is already used by someone else in this session, so '
            f"{name} was not matched to it and gets a new track. Put them on the right one by hand.",
            found,
        )
    return build(
        "matched",
        same[0],
        "name",
        f'{name} returns: matched by name to the existing track "{pool[same[0]]}".',
        found,
    )


def suggestion_for_session(project: EpisodeProject, session_id: str) -> SessionSuggestion | None:
    return next((s for s in list_session_suggestions(project) if s.session_id == session_id), None)
